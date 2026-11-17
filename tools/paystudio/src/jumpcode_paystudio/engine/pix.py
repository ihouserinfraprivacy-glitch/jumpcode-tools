# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""API Pix in the Banco Central standard (v2): OAuth token, immediate charges (cob), locations and QR codes,
received Pix, refunds (devolução) and the webhook, under /pix. Payments only happen when PayStudio simulates them."""

import json
import re
import secrets
import string
import time
import uuid

from . import brcode, wire
from .wire import GatewayError

NAME = "pix"
ERRORS = "https://pix.bcb.gov.br/api/v2/error/"
_TXID = re.compile(r"^[a-zA-Z0-9]{26,35}$")
_VALUE = re.compile(r"^\d{1,10}\.\d{2}$")
ISPB = "18236120"


def problem(status, kind, title, detail, violations=None):
    body = {"type": ERRORS + kind, "title": title, "status": status, "detail": detail}
    if violations:
        body["violacoes"] = [{"razao": reason, "propriedade": prop} for prop, reason in violations]
    return GatewayError(status, body, kind, detail)


def space(gw):
    return gw.state["pix"]


def handle(gw, request, path):
    method = request.method
    parts = [p for p in path.split("/") if p]
    if parts[:2] == ["oauth", "token"] and method == "POST":
        request.op = "token OAuth"
        return wire.json_response({"access_token": wire.token("pix_", 40), "token_type": "Bearer", "expires_in": 3600,
                                   "scope": "cob.write cob.read pix.read pix.write webhook.read webhook.write"})
    if not request.headers.get("authorization", "").lower().startswith("bearer "):
        raise problem(401, "AcessoNegado", "Acesso negado.", "Envie o token de acesso no cabeçalho Authorization: Bearer (obtido em /pix/oauth/token).")
    if parts[:1] == ["v2"]:
        parts = parts[1:]
    if not parts:
        raise problem(404, "RecursoNaoEncontrado", "Recurso não encontrado.", f"A rota {path} não existe na API Pix.")
    kind = parts[0]
    if kind == "cob":
        return cob_call(gw, request, parts[1:])
    if kind == "loc" and len(parts) == 3 and parts[2] == "qrcode":
        return qrcode(gw, request, parts[1])
    if kind == "pix":
        return pix_call(gw, request, parts[1:])
    if kind == "webhook":
        return webhook_call(gw, request, parts[1:])
    raise problem(404, "RecursoNaoEncontrado", "Recurso não encontrado.",
                  f"O PayStudio emula cob, loc, pix e webhook da API Pix; /{'/'.join(parts)} ainda não.")


def _body(request):
    try:
        value = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, ValueError):
        raise problem(400, "CobOperacaoInvalida", "Cobrança inválida.", "O corpo da requisição não é um JSON válido.")
    if not isinstance(value, dict):
        raise problem(400, "CobOperacaoInvalida", "Cobrança inválida.", "O corpo da requisição deve ser um objeto JSON.")
    return value


def cob_call(gw, request, parts):
    method = request.method
    if not parts:
        if method == "POST":
            request.op = "criar cob"
            return create_cob(gw, request, "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32)))
        request.op = "listar cobs"
        return list_cobs(gw, request)
    txid = parts[0]
    request.ref = txid
    if method == "PUT":
        request.op = "criar cob"
        return create_cob(gw, request, txid)
    cob = space(gw)["cobs"].get(txid)
    if cob is None:
        raise problem(404, "CobNaoEncontrado", "Cobrança não encontrada.", f"A cobrança em questão não foi encontrada para o txid {txid}.")
    if method == "GET":
        request.op = "consultar cob"
        return wire.json_response(view(gw, cob))
    if method == "PATCH":
        request.op = "revisar cob"
        return patch_cob(gw, request, cob)
    raise problem(405, "RecursoNaoEncontrado", "Método não permitido.", f"{method} não é aceito em /cob/{{txid}}.")


def create_cob(gw, request, txid):
    with gw.lock:
        return _create_cob(gw, request, txid)


def _create_cob(gw, request, txid):
    if not _TXID.match(txid):
        raise problem(400, "CobOperacaoInvalida", "Cobrança inválida.", "O txid deve ter de 26 a 35 caracteres alfanuméricos.",
                      [("cob.txid", "O campo cob.txid não respeita o schema.")])
    if txid in space(gw)["cobs"]:
        raise problem(400, "CobOperacaoInvalida", "Cobrança inválida.", f"Já existe uma cobrança com o txid {txid}.",
                      [("cob.txid", "O txid informado já está em uso.")])
    body = _body(request)
    value = (body.get("valor") or {}).get("original")
    violations = []
    if not isinstance(value, str) or not _VALUE.match(value) or wire.cents(value) <= 0:
        violations.append(("cob.valor.original", "O campo cob.valor.original não respeita o schema."))
    expiration = (body.get("calendario") or {}).get("expiracao", 86400)
    if not isinstance(expiration, int) or expiration <= 0:
        violations.append(("cob.calendario.expiracao", "O campo cob.calendario.expiracao deve ser um inteiro positivo."))
    if not body.get("chave"):
        violations.append(("cob.chave", "O campo cob.chave é obrigatório."))
    devedor = body.get("devedor")
    if devedor and not (devedor.get("cpf") or devedor.get("cnpj")):
        violations.append(("cob.devedor", "O devedor precisa de cpf ou cnpj junto com o nome."))
    if violations:
        raise problem(400, "CobOperacaoInvalida", "Cobrança inválida.",
                      "A requisição que busca alterar ou criar uma cobrança para pagamento imediato não respeita o schema ou está semanticamente errada.",
                      violations)
    from . import rules
    plan = rules.payment_plan(gw, NAME, ("pay_after", "expire_after"))
    if plan["expire_after"]:
        expiration = int(plan["expire_after"])
    now = time.time()
    with gw.lock:
        space(gw)["loc_seq"] += 1
        loc_id = space(gw)["loc_seq"]
        location = f"127.0.0.1:{gw.port}/pix/v2/loc/{uuid.uuid4()}"
        space(gw)["locs"][str(loc_id)] = {"id": loc_id, "location": location, "txid": txid, "criacao": now}
        cob = {"txid": txid, "revisao": 0, "criacao": now, "expiracao": expiration, "status": "ATIVA", "loc": loc_id, "location": location,
               "devedor": devedor, "valor": value, "chave": body["chave"], "solicitacaoPagador": body.get("solicitacaoPagador"),
               "infoAdicionais": body.get("infoAdicionais") or [], "pix": [],
               "ps": {"booking": gw.booking_from(body.get("solicitacaoPagador"), json.dumps(body.get("infoAdicionais") or []), txid),
                      "customer": (devedor or {}).get("nome"), "events": [], "flags": []}}
        cob["copia"] = brcode.dynamic(location, gw.settings.get("merchant", "BARBEARIA DO ZE"), gw.settings.get("city", "SAO PAULO"), value)
        space(gw)["cobs"][txid] = cob
    gw.event(cob, f"cob criada · {wire.brl(wire.cents(value))} · vence em {_duration(expiration)}", "info", "app")
    if plan["labels"]:
        gw.event(cob, f"cenário: {', '.join(plan['labels'])}", "scenario")
    if plan["pay_after"] is not None:
        gw.later(plan["pay_after"], {"kind": "pay", "gateway": NAME, "ref": txid}, f"pagar Pix {txid[:10]}…", txid)
    request.ref = txid
    request.note_res = {"txid": txid, "status": "ATIVA", "valor": value}
    return wire.json_response(view(gw, cob), 201)


def _duration(seconds):
    return f"{seconds // 60} min" if seconds % 60 == 0 and seconds >= 60 else f"{seconds} s"


def expired(cob, now=None):
    return cob["status"] == "ATIVA" and (now or time.time()) > cob["criacao"] + cob["expiracao"]


def view(gw, cob):
    result = {"calendario": {"criacao": wire.iso(cob["criacao"]), "expiracao": cob["expiracao"]}, "txid": cob["txid"], "revisao": cob["revisao"],
              "loc": {"id": cob["loc"], "location": cob["location"], "tipoCob": "cob", "criacao": wire.iso(cob["criacao"])},
              "location": cob["location"], "status": cob["status"], "valor": {"original": cob["valor"], "modalidadeAlteracao": 0},
              "chave": cob["chave"], "pixCopiaECola": cob["copia"]}
    if cob.get("devedor"):
        result["devedor"] = cob["devedor"]
    if cob.get("solicitacaoPagador"):
        result["solicitacaoPagador"] = cob["solicitacaoPagador"]
    if cob.get("infoAdicionais"):
        result["infoAdicionais"] = cob["infoAdicionais"]
    if cob["pix"]:
        result["pix"] = [pix_view(space(gw)["pix"][e2e]) for e2e in cob["pix"] if e2e in space(gw)["pix"]]
    return result


def list_cobs(gw, request):
    query = request.query
    status = query.get("status")
    cobs = [view(gw, c) for c in sorted(space(gw)["cobs"].values(), key=lambda c: c["criacao"]) if not status or c["status"] == status]
    return wire.json_response({"parametros": {"inicio": query.get("inicio"), "fim": query.get("fim"),
                                              "paginacao": {"paginaAtual": 0, "itensPorPagina": 100, "quantidadeDePaginas": 1,
                                                            "quantidadeTotalDeItens": len(cobs)}}, "cobs": cobs})


def patch_cob(gw, request, cob):
    body = _body(request)
    if cob["status"] != "ATIVA":
        raise problem(400, "CobOperacaoInvalida", "Cobrança inválida.", f"A cobrança está {cob['status']} e não pode ser alterada.")
    if body.get("status") == "REMOVIDA_PELO_USUARIO_RECEBEDOR":
        cob["status"] = "REMOVIDA_PELO_USUARIO_RECEBEDOR"
        gw.event(cob, "cob removida pelo recebedor", "warn", "app")
    if (body.get("valor") or {}).get("original"):
        value = body["valor"]["original"]
        if not _VALUE.match(str(value)):
            raise problem(400, "CobOperacaoInvalida", "Cobrança inválida.", "O campo cob.valor.original não respeita o schema.")
        cob["valor"] = value
        cob["copia"] = brcode.dynamic(cob["location"], gw.settings.get("merchant", "BARBEARIA DO ZE"), gw.settings.get("city", "SAO PAULO"), value)
        gw.event(cob, f"valor alterado para {wire.brl(wire.cents(value))}", "info", "app")
    if (body.get("calendario") or {}).get("expiracao"):
        cob["expiracao"] = int(body["calendario"]["expiracao"])
    cob["revisao"] += 1
    gw.touch("charges")
    return wire.json_response(view(gw, cob))


def qrcode(gw, request, loc_id):
    request.op = "QR Code"
    loc = space(gw)["locs"].get(str(loc_id))
    if loc is None:
        raise problem(404, "LocationNaoEncontrada", "Location não encontrada.", f"A location {loc_id} não existe.")
    cob = space(gw)["cobs"].get(loc["txid"])
    request.ref = loc["txid"]
    from . import qr
    return wire.json_response({"qrcode": cob["copia"], "imagemQrcode": qr.data_url(cob["copia"]), "linkVisualizacao": f"{gw.endpoint}/pix/v2/loc/{loc_id}/qrcode"})


def pix_call(gw, request, parts):
    if not parts:
        request.op = "listar Pix recebidos"
        items = [pix_view(p) for p in sorted(space(gw)["pix"].values(), key=lambda p: p["horario"])]
        return wire.json_response({"parametros": {"inicio": request.query.get("inicio"), "fim": request.query.get("fim"),
                                                  "paginacao": {"paginaAtual": 0, "itensPorPagina": 100, "quantidadeDePaginas": 1,
                                                                "quantidadeTotalDeItens": len(items)}}, "pix": items})
    e2e = parts[0]
    record = space(gw)["pix"].get(e2e)
    if record is None:
        raise problem(404, "PixNaoEncontrado", "Pix não encontrado.", f"Nenhum Pix recebido com o endToEndId {e2e}.")
    request.ref = record["txid"]
    if len(parts) == 1:
        request.op = "consultar Pix"
        return wire.json_response(pix_view(record))
    if len(parts) == 3 and parts[1] == "devolucao":
        if request.method == "PUT":
            request.op = "pedir devolução"
            return refund(gw, request, record, parts[2])
        request.op = "consultar devolução"
        found = next((d for d in record["devolucoes"] if d["id"] == parts[2]), None)
        if found is None:
            raise problem(404, "DevolucaoNaoEncontrada", "Devolução não encontrada.", f"Nenhuma devolução {parts[2]} para este Pix.")
        return wire.json_response(found)
    raise problem(404, "RecursoNaoEncontrado", "Recurso não encontrado.", "Rota de Pix desconhecida.")


def pix_view(record):
    result = {"endToEndId": record["endToEndId"], "txid": record["txid"], "valor": record["valor"], "chave": record["chave"],
              "horario": record["horario"], "infoPagador": record.get("infoPagador", ""), "pagador": record.get("pagador")}
    if record["devolucoes"]:
        result["devolucoes"] = record["devolucoes"]
    return result


def refund(gw, request, record, refund_id, amount=None):
    with gw.lock:
        return _refund(gw, request, record, refund_id, amount)


def _refund(gw, request, record, refund_id, amount=None):
    body = _body(request) if request is not None else {"valor": amount}
    value = str(body.get("valor") or "")
    if not _VALUE.match(value):
        raise problem(400, "DevolucaoInvalida", "Devolução inválida.", "O campo valor não respeita o schema.")
    returned = sum(wire.cents(d["valor"]) for d in record["devolucoes"])
    if wire.cents(value) + returned > wire.cents(record["valor"]):
        raise problem(400, "DevolucaoInvalida", "Devolução inválida.", "O valor da devolução é maior que o saldo do Pix.")
    if any(d["id"] == refund_id for d in record["devolucoes"]):
        raise problem(400, "DevolucaoInvalida", "Devolução inválida.", f"Já existe a devolução {refund_id}.")
    devolucao = {"id": refund_id, "rtrId": "D" + ISPB + time.strftime("%Y%m%d%H%M") + wire.token("", 11), "valor": value,
                 "horario": {"solicitacao": wire.iso()}, "status": "EM_PROCESSAMENTO"}
    record["devolucoes"].append(devolucao)
    cob = space(gw)["cobs"].get(record["txid"])
    if cob:
        gw.event(cob, f"devolução {refund_id} pedida · {wire.brl(wire.cents(value))}", "warn", "app" if request is not None else "PayStudio")

    gw.later(2, {"kind": "refund", "gateway": NAME, "ref": record["endToEndId"], "refund_id": refund_id},
             f"concluir devolução {refund_id}", record["txid"])
    return wire.json_response(devolucao, 201)


def finish_refund(gw, end_to_end_id, refund_id):
    record = space(gw)["pix"].get(end_to_end_id)
    if not record:
        return
    refund = next((d for d in record["devolucoes"] if d["id"] == refund_id), None)
    if not refund or refund["status"] != "EM_PROCESSAMENTO":
        return
    refund["status"] = "DEVOLVIDO"
    refund["horario"]["liquidacao"] = wire.iso()
    cob = space(gw)["cobs"].get(record["txid"])
    if cob:
        gw.event(cob, f"devolução {refund_id} concluída", "warn")
    notify(gw, record)


def webhook_call(gw, request, parts):
    key = parts[0] if parts else None
    hooks = space(gw)["webhooks"]
    if request.method == "PUT" and key:
        request.op = "configurar webhook"
        body = _body(request)
        url = body.get("webhookUrl") or ""
        from .local_http import local_url
        if not local_url(url):
            raise problem(400, "WebhookOperacaoInvalida", "Webhook inválido.",
                          "O PayStudio só entrega webhooks em endereços deste computador (localhost ou 127.0.0.1).")
        hooks[key] = {"webhookUrl": url, "chave": key, "criacao": wire.iso()}
        gw.touch("pay")
        return wire.json_response(hooks[key])
    if request.method == "GET" and key:
        request.op = "consultar webhook"
        if key not in hooks or not hooks[key].get("webhookUrl"):
            raise problem(404, "WebhookNaoEncontrado", "Webhook não encontrado.", f"Nenhum webhook para a chave {key}.")
        return wire.json_response(hooks[key])
    if request.method == "DELETE" and key:
        request.op = "remover webhook"
        # An explicit removal must also override the optional Studio-wide fallback.
        hooks[key] = {"chave": key, "webhookUrl": ""}
        gw.touch("pay")
        return wire.Response(204, b"")
    request.op = "listar webhooks"
    return wire.json_response({"webhooks": [hook for hook in hooks.values() if hook.get("webhookUrl")]})


# ---------------------------------------------------------------- what PayStudio simulates

def find(gw, ref):
    """A cob by txid, by booking or by the start of the txid."""
    cobs = space(gw)["cobs"]
    if ref in cobs:
        return cobs[ref]
    for cob in sorted(cobs.values(), key=lambda c: c["criacao"], reverse=True):
        if (cob["ps"].get("booking") or "").lower() == str(ref).lower() or cob["txid"].lower().startswith(str(ref).lower()):
            return cob
    return None


def pay(gw, txid, amount=None, payer=None, by="PayStudio"):
    """The payer pays the cob in their bank app: the cob is CONCLUIDA and the webhook goes to the app."""
    cob = space(gw)["cobs"].get(txid)
    if cob is None:
        raise ValueError(f"No Pix charge {txid}")
    if cob["status"] != "ATIVA":
        raise ValueError(f"The Pix charge is {cob['status']}")
    if expired(cob):
        raise ValueError("The Pix charge is past its expiration; banks refuse to pay it")
    value = amount or cob["valor"]
    devedor = payer or cob.get("devedor") or {"nome": "Pagador de teste", "cpf": "12345678909"}
    e2e = "E" + ISPB + time.strftime("%Y%m%d%H%M", time.gmtime()) + wire.token("", 11, string.ascii_lowercase + string.digits)
    record = {"endToEndId": e2e, "txid": cob["txid"], "valor": value, "chave": cob["chave"], "horario": wire.iso(),
              "infoPagador": "", "pagador": {k: v for k, v in devedor.items() if k in ("cpf", "cnpj", "nome")}, "devolucoes": []}
    with gw.lock:
        space(gw)["pix"][e2e] = record
        cob["pix"].append(e2e)
        cob["status"] = "CONCLUIDA"
        cob["paid"] = time.time()
    gw.event(cob, f"pago pelo pagador · {wire.brl(wire.cents(value))} · e2eid {e2e[-10:]}", "ok", by)
    notify(gw, record)
    return record


def notify(gw, record):
    from . import webhooks
    cob = space(gw)["cobs"].get(record["txid"])
    hook = space(gw)["webhooks"].get(record["chave"])
    delivery = webhooks.enqueue(gw, NAME, "pix", record["txid"], {"pix": [pix_view(record)]},
                                url=hook["webhookUrl"] if hook is not None else None,
                                booking=(cob or {}).get("ps", {}).get("booking"))
    if cob:
        gw.event(cob, f"webhook #{delivery['id']} para o app" + (f" · {delivery['note']}" if delivery.get("note") else ""), "webhook")


def expire_now(gw, txid):
    cob = space(gw)["cobs"].get(txid)
    if cob is None or cob["status"] != "ATIVA":
        raise ValueError("Only an active Pix charge can expire")
    cob["expiracao"] = max(1, int(time.time() - cob["criacao"]) - 1)
    gw.event(cob, "vencimento antecipado pelo PayStudio: a cobrança não pode mais ser paga (o padrão do Banco Central não manda webhook de vencimento)", "warn")


def charges(gw):
    result = []
    now = time.time()
    for cob in space(gw)["cobs"].values():
        records = [space(gw)["pix"][e] for e in cob["pix"] if e in space(gw)["pix"]]
        refunded = sum(wire.cents(d["valor"]) for r in records for d in r["devolucoes"] if d["status"] == "DEVOLVIDO")
        status = {"ATIVA": "expirada" if expired(cob, now) else "pendente", "CONCLUIDA": "paga"}.get(cob["status"], "cancelada")
        if status == "paga" and refunded:
            status = "estornada" if refunded >= wire.cents(cob["valor"]) else "estorno_parcial"
        result.append({"gateway": NAME, "ref": cob["txid"], "method": "pix", "amount": wire.cents(cob["valor"]), "status": status,
                       "gatewayStatus": cob["status"], "created": cob["criacao"], "expires": cob["criacao"] + cob["expiracao"],
                       "paid": cob.get("paid"), "booking": cob["ps"].get("booking"), "customer": cob["ps"].get("customer"),
                       "events": cob["ps"].get("events", []), "flags": cob["ps"].get("flags", []), "refunded": refunded,
                       "details": {"txid": cob["txid"], "revisao": cob["revisao"], "chave": cob["chave"], "location": cob["location"],
                                   "pixCopiaECola": cob["copia"], "solicitacaoPagador": cob.get("solicitacaoPagador"),
                                   "devedor": cob.get("devedor"), "e2eids": [r["endToEndId"] for r in records],
                                   "devolucoes": [d for r in records for d in r["devolucoes"]]}})
    return result

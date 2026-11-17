# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Dev only: runs the "Barbearia do Zé" backend on a real local cloud (functions, API, queues, the app's calls
and a few real bugs) and saves the Studio files it produced in ui-dev/fixtures/barbearia, for the harness.
Needs boto3 (set CLOUDSTUDIO_TEST_SDK to a folder that has it). Run from this folder: python scenario.py"""

import base64
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE.parent / "tests"))
from support import LocalCloud, boto3, wait_for  # noqa: E402

SDK = os.environ.get("CLOUDSTUDIO_TEST_SDK", "")
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAWklEQVR42u3OMQ0AAAgDsM2/aDCBQkKdQAuo2jM1TgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQExgUGv3cBrQ6O0RUAAAAASUVORK5CYII=")

AGENDAR = '''import json, os, uuid
import boto3

dynamo = boto3.client("dynamodb")


def handler(event, context):
    pedido = json.loads(event.get("body") or "{}")
    ag_id = "AG-" + uuid.uuid4().hex[:4].upper()
    print("novo agendamento", ag_id, pedido.get("cliente"))
    dynamo.put_item(TableName=os.environ["TABELA_AGENDAMENTOS"], Item={
        "id": {"S": ag_id}, "cliente": {"S": pedido["cliente"]}, "servico": {"S": pedido["servico"]},
        "horario": {"S": pedido["horario"]}, "valor": {"N": str(pedido.get("valor", 35))}, "status": {"S": "pendente"}})
    # o cadastro do cliente usa o mesmo formulario do app
    dynamo.put_item(TableName=os.environ["TABELA_CLIENTES"], Item={
        "fone": {"S": pedido["telefone"]}, "nome": {"S": pedido["cliente"]}})
    return {"statusCode": 201, "body": json.dumps({"id": ag_id})}
'''

HORARIOS = '''import json, os
import boto3

dynamo = boto3.client("dynamodb")


def handler(event, context):
    itens = dynamo.scan(TableName=os.environ["TABELA_AGENDAMENTOS"])["Items"]
    ocupados = sorted(i["horario"]["S"] for i in itens)
    print("horarios ocupados", len(ocupados))
    return {"statusCode": 200, "body": json.dumps({"ocupados": ocupados})}
'''

LEMBRETE = '''import json
import boto3

secrets = boto3.client("secretsmanager")


def handler(event, context):
    token = secrets.get_secret_value(SecretId="whatsapp/token")["SecretString"]
    for record in event["Records"]:
        aviso = json.loads(record["body"])
        print("lembrete para", aviso.get("telefone"))
        if not token:
            raise RuntimeError("token do WhatsApp vazio: nao da para enviar o lembrete")
    return {}
'''

CONFIRMAR = '''def handler(event, context):
    print("confirmando pagamento", event.get("pagamento"))
    if event.get("valor", 0) <= 0:
        raise ValueError("valor do pagamento invalido")
    return {"pago": True, "agendamento": event.get("agendamento")}
'''

FLOW = {
    "Comment": "Confirma o pagamento e avisa o cliente",
    "StartAt": "ConfirmarPagamento",
    "States": {
        "ConfirmarPagamento": {"Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
                               "Parameters": {"FunctionName": "confirmar-pix", "Payload.$": "$"}, "ResultSelector": {"r.$": "$.Payload"},
                               "ResultPath": "$.pagamento", "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.erro", "Next": "PagamentoFalhou"}],
                               "Next": "Pago?"},
        "Pago?": {"Type": "Choice", "Choices": [{"Variable": "$.pagamento.r.pago", "BooleanEquals": True, "Next": "AvisarCliente"}], "Default": "PagamentoFalhou"},
        "AvisarCliente": {"Type": "Task", "Resource": "arn:aws:states:::sns:publish",
                          "Parameters": {"TopicArn": "arn:aws:sns:sa-east-1:000000000000:pagamento-confirmado", "Message.$": "$"}, "End": True},
        "PagamentoFalhou": {"Type": "Fail", "Error": "PagamentoRecusado", "Cause": "O Pix não foi confirmado"},
    },
}


def main():
    if boto3 is None:
        raise SystemExit("boto3 is needed: set CLOUDSTUDIO_TEST_SDK")
    work = Path(tempfile.mkdtemp(prefix="cs-barbearia-"))
    project = work / "barbearia"
    for folder, text in (("agendar", AGENDAR), ("horarios", HORARIOS), ("lembrete", LEMBRETE), ("confirmar-pix", CONFIRMAR)):
        (project / "backend" / folder).mkdir(parents=True)
        (project / "backend" / folder / "app.py").write_text(text, encoding="utf-8")
    studio = work / "studio"
    studio.mkdir()
    local = LocalCloud(region="sa-east-1", folder=studio)
    cloud = local.cloud
    from jumpcode_cloudstudio.engine import admin
    from jumpcode_cloudstudio.engine.server import Request

    def create(spec):
        return admin.create(cloud, spec)

    try:
        env = {"TABELA_AGENDAMENTOS": "agendamentos", "TABELA_CLIENTES": "clientes", "PYTHONPATH": SDK}
        create({"service": "dynamodb", "name": "agendamentos", "key": "id", "indexes": [{"name": "por-horario", "key": "horario"}]})
        create({"service": "dynamodb", "name": "clientes", "key": "telefone"})
        create({"service": "s3", "name": "barbearia-fotos"})
        create({"service": "sqs", "name": "lembretes", "dlq": "lembretes-dlq", "maxReceives": 2, "visibility": 1})
        create({"service": "sns", "name": "pagamento-confirmado", "subscribe": [{"queue": "lembretes"}, {"email": "ze@barbeariadoze.com.br"}]})
        create({"service": "lambda", "name": "agendar", "folder": str(project / "backend" / "agendar"), "handler": "app.handler", "env": env, "timeout": 10})
        create({"service": "lambda", "name": "listar-horarios", "folder": str(project / "backend" / "horarios"), "handler": "app.handler", "env": env, "timeout": 10})
        create({"service": "lambda", "name": "enviar-lembrete", "folder": str(project / "backend" / "lembrete"), "handler": "app.handler",
                "env": {"PYTHONPATH": SDK, "WHATSAPP_TOKEN": ""}, "timeout": 10, "queue": "lembretes", "batch": 1})
        create({"service": "lambda", "name": "confirmar-pix", "folder": str(project / "backend" / "confirmar-pix"), "handler": "app.handler", "timeout": 5})
        create({"service": "apigatewayv2", "name": "barbearia-api", "routes": [{"route": "POST /agendamentos", "function": "agendar"},
                                                                                {"route": "GET /horarios", "function": "listar-horarios"}]})
        create({"service": "secretsmanager", "name": "whatsapp/token", "value": "", "fromEnv": "WHATSAPP_TOKEN"})
        create({"service": "secretsmanager", "name": "pix/chave-sandbox", "value": "chave-sandbox-1234567890", "fromEnv": "PIX_CHAVE"})
        create({"service": "ssm", "name": "/barbearia/horario-funcionamento", "value": "09:00-19:00"})
        create({"service": "ssm", "name": "/barbearia/pix/webhook-segredo", "value": "s3gr3d0", "secure": True})
        create({"service": "scheduler", "name": "lembrete-diario", "expression": "cron(0 12 * * ? *)", "timezone": "America/Sao_Paulo",
                "target": "queue:lembretes", "input": {"tipo": "lembrete-diario"}})
        create({"service": "events", "name": "agendamento-cancelado", "pattern": {"source": ["barbearia.app"], "detail-type": ["AgendamentoCancelado"]},
                "targets": ["queue:lembretes"]})
        create({"service": "stepfunctions", "name": "confirmar-pagamento", "definition": FLOW})

        # The app (boto3 with its own user agent) fills tables and the bucket.
        ddb = local.client("dynamodb", region="sa-east-1")
        rows = [("AG-4821", "Paulo Ribeiro", "corte", "2026-11-14T09:00", 45, "confirmado"),
                ("AG-4822", "Lucas Mendes", "barba", "2026-11-14T09:30", 30, "confirmado"),
                ("AG-4830", "Carlos Andrade", "corte e barba", "2026-11-14T10:30", 70, "pendente"),
                ("AG-4840", "Rafael Costa", "corte", "2026-11-14T14:00", 45, "confirmado"),
                ("AG-4841", "André Lima", "sobrancelha", "2026-11-14T15:30", 20, "cancelado"),
                ("AG-4846", "Bruno Alves", "corte e barba", "2026-11-14T16:00", 70, "confirmado")]
        for ag, nome, servico, horario, valor, status in rows:
            ddb.put_item(TableName="agendamentos", Item={"id": {"S": ag}, "cliente": {"S": nome}, "servico": {"S": servico},
                                                         "horario": {"S": horario}, "valor": {"N": str(valor)}, "status": {"S": status}})
        for telefone, nome in (("5511987654321", "Carlos Andrade"), ("5511912345678", "Paulo Ribeiro"), ("5511955554444", "Rafael Costa")):
            ddb.put_item(TableName="clientes", Item={"telefone": {"S": telefone}, "nome": {"S": nome}, "desde": {"S": "2025-03-10"}})
        s3 = local.client("s3", region="sa-east-1")
        s3.put_object(Bucket="barbearia-fotos", Key="cortes/degrade.png", Body=PNG, ContentType="image/png")
        s3.put_object(Bucket="barbearia-fotos", Key="cortes/social.png", Body=PNG, ContentType="image/png")
        s3.put_object(Bucket="barbearia-fotos", Key="tabela-de-precos.json", ContentType="application/json",
                      Body=json.dumps({"corte": 45, "barba": 30, "corte e barba": 70, "sobrancelha": 20}, ensure_ascii=False, indent=2).encode())
        s3.put_object(Bucket="barbearia-fotos", Key="avisos/feriado.txt", Body="Fechado no dia 20/11 (feriado).".encode(), ContentType="text/plain")
        local.client("ssm", region="sa-east-1").get_parameter(Name="/barbearia/horario-funcionamento")

        api_id = next(iter(cloud.store.regional("000000000000", "sa-east-1", "apigatewayv2")["apis"]))

        def http(method, path, body=None):
            data = json.dumps(body).encode() if body is not None else None
            request = urllib.request.Request(f"{cloud.endpoint}/_api/{api_id}{path}", data, method=method,
                                             headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (app da barbearia)"})
            try:
                with urllib.request.urlopen(request) as answer:
                    return answer.status
            except urllib.error.HTTPError as error:
                return error.code

        http("GET", "/horarios")
        http("POST", "/agendamentos", {"cliente": "Diego Souza", "telefone": "5511933332222", "servico": "corte", "horario": "2026-11-14T11:30", "valor": 45})
        http("GET", "/horarios")

        sqs = local.client("sqs", region="sa-east-1")
        url = sqs.get_queue_url(QueueName="lembretes")["QueueUrl"]
        sqs.send_message(QueueUrl=url, MessageBody=json.dumps({"telefone": "5511987654321", "agendamento": "AG-4830"}))
        sqs.send_message(QueueUrl=url, MessageBody=json.dumps({"telefone": "5511912345678", "agendamento": "AG-4821"}))

        sfn = boto3.client("stepfunctions", endpoint_url=cloud.endpoint, region_name="sa-east-1", aws_access_key_id="test", aws_secret_access_key="test",
                           config=__import__("botocore.config").config.Config(inject_host_prefix=False))
        machine = "arn:aws:states:sa-east-1:000000000000:stateMachine:confirmar-pagamento"
        sfn.start_sync_execution(stateMachineArn=machine, input=json.dumps({"agendamento": "AG-4821", "pagamento": "PIX-881", "valor": 45}))
        sfn.start_sync_execution(stateMachineArn=machine, input=json.dumps({"agendamento": "AG-4830", "pagamento": "PIX-882", "valor": 0}))

        wait_for(lambda: any(r["name"] == "lembretes-dlq" and r["count"] >= 2 for r in cloud.summary()), timeout=25)
        cloud.store.snapshot("antes de corrigir o cadastro", {"resources": len(cloud.summary())})
        request = Request("GET", "/", {}, b"", "sa-east-1")
        del request
        cloud.runtime.interpreter("python")
        cloud.runtime.interpreter("node")
        cloud.live.mark("cloud", "resources", "calls", "logs")
        time.sleep(1.2)
        target = HERE / "fixtures" / "barbearia"
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        for name in ("cloud.json", "resources.json", "calls.json", "logs.json"):
            text = (studio / name).read_text(encoding="utf-8").replace(str(project).replace("\\", "\\\\"), "C:\\\\Projetos\\\\barbearia")
            text = text.replace(f"127.0.0.1:{cloud.port}", "127.0.0.1:4566").replace(f'"port":{cloud.port}', '"port":4566')
            if name == "resources.json":
                # The harness points functions at a local boto3 through PYTHONPATH; the app would not have it.
                value = json.loads(text)
                for resource in value["resources"]:
                    if resource["service"] == "lambda":
                        resource["env"] = [n for n in resource["env"] if n != "PYTHONPATH"]
                text = json.dumps(value, ensure_ascii=False)
            (target / name).write_text(text, encoding="utf-8")
        (target / "settings.json").write_text(json.dumps({"schema": 1, "storage": "memory", "region": "sa-east-1"}), encoding="utf-8")
        print("fixtures:", sorted(p.name for p in target.iterdir()))
        summary = json.loads((target / "calls.json").read_text(encoding="utf-8"))
        print("calls:", summary["total"], "errors:", summary["errors"])
    finally:
        local.close()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

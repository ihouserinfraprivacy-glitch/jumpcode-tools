# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Pure logic without a running cloud: DynamoDB expressions, event patterns, schedules, query-protocol
parameters and the state store."""

from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jumpcode_cloudstudio.engine import wire  # noqa: E402
from jumpcode_cloudstudio.engine.services import dynamo_expr as ex, patterns, timing  # noqa: E402
from jumpcode_cloudstudio.engine.state import Store  # noqa: E402
from jumpcode_cloudstudio.engine.wire import AwsError  # noqa: E402

ITEM = {"id": {"S": "AG-1"}, "valor": {"N": "35"}, "tags": {"SS": ["corte", "barba"]}, "cliente": {"M": {"nome": {"S": "Zé"}}},
        "horarios": {"L": [{"S": "09:00"}, {"S": "10:00"}]}, "ativo": {"BOOL": True}}


def used():
    return {"names": set(), "values": set()}


class ExpressionTests(unittest.TestCase):
    def condition(self, text, values=None, names=None):
        return ex.Condition(text, names or {}, values or {}, used())(ITEM)

    def test_conditions(self):
        self.assertEqual([
            self.condition("valor > :v", {":v": {"N": "30"}}),
            self.condition("valor BETWEEN :a AND :b", {":a": {"N": "40"}, ":b": {"N": "50"}}),
            self.condition("attribute_exists(cliente.nome) AND NOT attribute_exists(sumiu)"),
            self.condition("begins_with(id, :p)", {":p": {"S": "AG-"}}),
            self.condition("contains(tags, :t) OR valor < :v", {":t": {"S": "barba"}, ":v": {"N": "1"}}),
            self.condition("size(horarios) = :n", {":n": {"N": "2"}}),
            self.condition("#a IN (:x, :y)", {":x": {"BOOL": False}, ":y": {"BOOL": True}}, {"#a": "ativo"}),
            self.condition("horarios[1] = :h", {":h": {"S": "10:00"}}),
            self.condition("valor = :v", {":v": {"S": "35"}}),
        ], [True, False, True, True, True, True, True, True, False])

    def test_errors_name_what_is_wrong(self):
        messages = []
        for text, values, names in (("valor > :nada", {}, {}), ("#x = :v", {":v": {"S": "a"}}, {}), ("status = :v", {":v": {"S": "a"}}, {})):
            with self.assertRaises(AwsError) as caught:
                ex.Condition(text, names, values, used())
            messages.append(caught.exception.message)
        self.assertEqual(messages, [
            "An expression attribute value used in expression is not defined; attribute value: :nada",
            "An expression attribute name used in the document path is not defined; attribute name: #x",
            "Invalid expression: Attribute name is a reserved keyword; reserved keyword: status",
        ])

    def test_update(self):
        update = ex.Update("SET valor = valor + :v, cliente.fone = :f, horarios = list_append(horarios, :h), visitas = if_not_exists(visitas, :zero) "
                           "REMOVE ativo ADD tags :t",
                           {}, {":v": {"N": "4.5"}, ":f": {"S": "1199"}, ":h": {"L": [{"S": "11:00"}]}, ":zero": {"N": "0"},
                                ":t": {"SS": ["sobrancelha"]}}, used())
        new, changed = update.apply(ITEM)
        removed, _ = ex.Update("DELETE tags :d", {}, {":d": {"SS": ["corte", "barba"]}}, used()).apply(ITEM)
        self.assertEqual((new, sorted(set(changed)), "tags" in removed), ({
            "id": {"S": "AG-1"}, "valor": {"N": "39.5"}, "tags": {"SS": ["corte", "barba", "sobrancelha"]},
            "cliente": {"M": {"nome": {"S": "Zé"}, "fone": {"S": "1199"}}},
            "horarios": {"L": [{"S": "09:00"}, {"S": "10:00"}, {"S": "11:00"}]}, "visitas": {"N": "0"}},
            ["ativo", "cliente", "horarios", "tags", "valor", "visitas"], False))

    def test_update_rejects_overlapping_paths(self):
        with self.assertRaises(AwsError) as caught:
            ex.Update("SET a = :v, a.b = :v", {}, {":v": {"S": "x"}}, used())
        self.assertIn("Two document paths overlap", caught.exception.message)

    def test_key_condition(self):
        hash_value, test = ex.key_condition("pk = :p AND begins_with(sk, :d)", {}, {":p": {"S": "BARBEIRO#joao"}, ":d": {"S": "2026-11-14"}},
                                            used(), "pk", "sk")
        self.assertEqual((hash_value, test({"sk": {"S": "2026-11-14T10:30"}}), test({"sk": {"S": "2026-11-15T10:30"}})),
                         ({"S": "BARBEIRO#joao"}, True, False))
        with self.assertRaises(AwsError) as caught:
            ex.key_condition("sk = :d", {}, {":d": {"S": "x"}}, used(), "pk", "sk")
        self.assertEqual(caught.exception.message, "Query condition missed key schema element: pk")

    def test_projection_keeps_structure(self):
        paths = ex.projection("id, cliente.nome, horarios[1]", {}, used())
        self.assertEqual(ex.project(ITEM, paths), {"id": {"S": "AG-1"}, "cliente": {"M": {"nome": {"S": "Zé"}}}, "horarios": {"L": [{"S": "10:00"}]}})

    def test_numbers_are_canonical(self):
        self.assertEqual([ex.canonical({"N": text})["N"] for text in ("010", "1.50", "1E+2", "-0.000")], ["10", "1.5", "100", "0"])


class PatternTests(unittest.TestCase):
    def test_event_patterns(self):
        event = {"source": "barbearia.app", "detail-type": "AgendamentoCriado", "detail": {"valor": 70, "servico": "corte e barba", "cliente": {"vip": True}}}
        self.assertEqual([
            patterns.matches({"source": ["barbearia.app"]}, event),
            patterns.matches({"detail": {"valor": [{"numeric": [">", 50, "<=", 70]}]}}, event),
            patterns.matches({"detail": {"servico": [{"prefix": "corte"}], "cliente": {"vip": [True]}}}, event),
            patterns.matches({"detail": {"desconto": [{"exists": False}]}}, event),
            patterns.matches({"detail-type": [{"anything-but": ["AgendamentoCriado"]}]}, event),
            patterns.matches({"$or": [{"source": ["outro"]}, {"detail": {"valor": [70]}}]}, event),
        ], [True, True, True, True, False, True])

    def test_sns_filter_policy(self):
        attributes = {"tipo": {"DataType": "String", "StringValue": "lembrete"}, "valor": {"DataType": "Number", "StringValue": "70"}}
        self.assertEqual([patterns.filter_policy({"tipo": ["lembrete"]}, attributes),
                          patterns.filter_policy({"valor": [{"numeric": ["<", 50]}]}, attributes)], [True, False])


class TimingTests(unittest.TestCase):
    def test_next_runs(self):
        created = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc).timestamp()
        after = datetime(2026, 11, 13, 12, 7, tzinfo=timezone.utc).timestamp()
        runs = [
            timing.next_run("rate(5 minutes)", after, None, created),
            timing.next_run("cron(0 12 * * ? *)", after, "America/Sao_Paulo"),
            timing.next_run("cron(30 8 ? * MON-FRI *)", after, "UTC"),
            timing.next_run("cron(0 0 L * ? *)", after, "UTC"),
            timing.next_run("at(2026-11-13T09:00:00)", after, "UTC"),
        ]
        iso = [datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%d %H:%M") if value else None for value in runs]
        self.assertEqual(iso, ["2026-11-13 12:10", "2026-11-13 15:00", "2026-11-16 08:30", "2026-11-30 00:00", None])

    def test_bad_expressions(self):
        for expression in ("cron(0 12 * * * *)", "every day", "rate(5 weeks)"):
            with self.assertRaises(AwsError):
                timing.validate(expression)


class WireTests(unittest.TestCase):
    def test_query_parameters(self):
        form = {"Attributes.entry.1.key": "RawMessageDelivery", "Attributes.entry.1.value": "true", "Tags.member.1.Key": "app",
                "Tags.member.1.Value": "barbearia", "MessageAttributes.entry.1.Name": "tipo", "MessageAttributes.entry.1.Value.DataType": "String",
                "MessageAttributes.entry.1.Value.StringValue": "lembrete", "TopicArn": "arn"}
        self.assertEqual(wire.flatten_query(form), {"Attributes": {"RawMessageDelivery": "true"}, "Tags": [{"Key": "app", "Value": "barbearia"}],
                                                    "MessageAttributes": {"tipo": {"DataType": "String", "StringValue": "lembrete"}}, "TopicArn": "arn"})

    def test_xml(self):
        self.assertEqual(wire.xml("R", {"A": [1, 2], "B": {"C": "x<y"}, "D": True}), "<R><A>1</A><A>2</A><B><C>x&lt;y</C></B><D>true</D></R>")


class StoreTests(unittest.TestCase):
    def test_persistence_copies_and_blob_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder), persistent=True)
            digest = store.put_blob(b"foto")
            store.regional("000000000000", "sa-east-1", "s3")["x"] = {"blob": digest}
            store.touch()
            copy = store.snapshot("antes")
            store.regional("000000000000", "sa-east-1", "s3")["x"] = {"blob": store.put_blob(b"outra")}
            store.touch()
            store.save()
            reloaded = Store(Path(folder), persistent=True)
            reloaded.load()
            self.assertEqual(reloaded.get_blob(reloaded.regional("000000000000", "sa-east-1", "s3")["x"]["blob"]), b"outra")
            self.assertTrue(reloaded.restore(copy["id"]))
            reloaded.gc_blobs()
            self.assertEqual((reloaded.get_blob(reloaded.regional("000000000000", "sa-east-1", "s3")["x"]["blob"]), [s["name"] for s in reloaded.snapshots()]),
                             (b"foto", ["antes"]))
            self.assertTrue(reloaded.delete_snapshot(copy["id"]))
            self.assertEqual(reloaded.blob_path(digest).exists(), True)


if __name__ == "__main__":
    unittest.main()

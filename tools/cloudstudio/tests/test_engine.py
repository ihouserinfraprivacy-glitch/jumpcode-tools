# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The emulator through the real AWS SDK (boto3): each service answers the way the SDK expects, errors keep
AWS's names, and the Studio files show what happened. Skipped when boto3 is not available."""

import base64
import io
import json
from pathlib import Path
import sys
import time
import unittest
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from support import CloudTest, LocalCloud, boto3, needs_sdk, wait_for  # noqa: E402
from jumpcode_cloudstudio.engine.local_http import open_local

if boto3 is not None:
    from botocore.config import Config
    from botocore.exceptions import ClientError


def code(error):
    return error.exception.response["Error"]["Code"]


@needs_sdk
class S3Tests(CloudTest):
    def test_objects(self):
        s3 = self.client("s3")
        s3.create_bucket(Bucket="fotos")
        s3.put_object(Bucket="fotos", Key="cortes/degrade.png", Body=b"\x89PNG", ContentType="image/png", Metadata={"autor": "ze"})
        s3.put_object(Bucket="fotos", Key="precos.json", Body=b'{"corte": 45}')
        s3.upload_fileobj(io.BytesIO(b"x" * (9 * 1024 * 1024)), "fotos", "grande.bin")
        s3.copy_object(Bucket="fotos", Key="copia.json", CopySource={"Bucket": "fotos", "Key": "precos.json"})
        head = s3.head_object(Bucket="fotos", Key="cortes/degrade.png")
        ranged = s3.get_object(Bucket="fotos", Key="precos.json", Range="bytes=2-6")["Body"].read()
        listing = s3.list_objects_v2(Bucket="fotos", Delimiter="/")
        with self.assertRaises(ClientError) as missing:
            s3.get_object(Bucket="fotos", Key="nada")
        with self.assertRaises(ClientError) as not_empty:
            s3.delete_bucket(Bucket="fotos")
        self.assertEqual((head["ContentType"], head["Metadata"], ranged, [o["Key"] for o in listing["Contents"]],
                          [p["Prefix"] for p in listing["CommonPrefixes"]], s3.head_object(Bucket="fotos", Key="grande.bin")["ContentLength"],
                          code(missing), code(not_empty)),
                         ("image/png", {"autor": "ze"}, b'corte', ["copia.json", "grande.bin", "precos.json"], ["cortes/"], 9 * 1024 * 1024,
                          "NoSuchKey", "BucketNotEmpty"))

    def test_bucket_events_reach_a_queue(self):
        s3, sqs = self.client("s3"), self.client("sqs")
        url = sqs.create_queue(QueueName="uploads")["QueueUrl"]
        arn = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        s3.create_bucket(Bucket="entrada")
        s3.put_bucket_notification_configuration(Bucket="entrada", NotificationConfiguration={
            "QueueConfigurations": [{"QueueArn": arn, "Events": ["s3:ObjectCreated:*"], "Filter": {"Key": {"FilterRules": [{"Name": "suffix", "Value": ".csv"}]}}}]})
        s3.put_object(Bucket="entrada", Key="ignorado.txt", Body=b"x")
        s3.put_object(Bucket="entrada", Key="lista.csv", Body=b"a,b")
        messages = sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10, WaitTimeSeconds=2).get("Messages", [])
        records = [json.loads(m["Body"])["Records"][0] for m in messages]
        self.assertEqual([(r["eventName"], r["s3"]["object"]["key"]) for r in records], [("ObjectCreated:Put", "lista.csv")])


@needs_sdk
class DynamoTests(CloudTest):
    def test_tables_and_items(self):
        ddb = self.client("dynamodb")
        ddb.create_table(TableName="agenda", BillingMode="PAY_PER_REQUEST",
                         KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
                         AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"},
                                               {"AttributeName": "cliente", "AttributeType": "S"}],
                         GlobalSecondaryIndexes=[{"IndexName": "por-cliente", "KeySchema": [{"AttributeName": "cliente", "KeyType": "HASH"}],
                                                  "Projection": {"ProjectionType": "ALL"}}])
        table = boto3.resource("dynamodb", endpoint_url=self.local.endpoint, region_name="us-east-1", aws_access_key_id="test",
                               aws_secret_access_key="test").Table("agenda")
        with table.batch_writer() as batch:
            for hour in ("09:00", "09:30", "10:30"):
                batch.put_item(Item={"pk": "BARBEIRO#joao", "sk": f"2026-11-14T{hour}", "cliente": "Carlos", "valor": 45})
        table.put_item(Item={"pk": "BARBEIRO#ana", "sk": "2026-11-14T09:00", "cliente": "Paulo", "valor": 30})
        table.update_item(Key={"pk": "BARBEIRO#joao", "sk": "2026-11-14T09:30"}, UpdateExpression="SET valor = valor + :v, #s = :s",
                          ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":v": 25, ":s": "confirmado"})
        from boto3.dynamodb.conditions import Attr, Key
        morning = table.query(KeyConditionExpression=Key("pk").eq("BARBEIRO#joao") & Key("sk").begins_with("2026-11-14T09"), ScanIndexForward=False)
        expensive = table.scan(FilterExpression=Attr("valor").gt(40))
        by_client = table.query(IndexName="por-cliente", KeyConditionExpression=Key("cliente").eq("Carlos"), Limit=2)
        with self.assertRaises(ClientError) as taken:
            table.put_item(Item={"pk": "BARBEIRO#ana", "sk": "2026-11-14T09:00"}, ConditionExpression="attribute_not_exists(pk)")
        with self.assertRaises(ClientError) as missing_key:
            ddb.put_item(TableName="agenda", Item={"pk": {"S": "x"}, "fone": {"S": "1"}})
        with self.assertRaises(ClientError) as transaction:
            ddb.transact_write_items(TransactItems=[
                {"Put": {"TableName": "agenda", "Item": {"pk": {"S": "BARBEIRO#ze"}, "sk": {"S": "x"}}}},
                {"ConditionCheck": {"TableName": "agenda", "Key": {"pk": {"S": "BARBEIRO#ana"}, "sk": {"S": "2026-11-14T09:00"}},
                                    "ConditionExpression": "valor > :v", "ExpressionAttributeValues": {":v": {"N": "100"}}}}])
        self.assertEqual(([i["sk"][-5:] for i in morning["Items"]], morning["Items"][0].get("status"), sorted(int(i["valor"]) for i in expensive["Items"]),
                          by_client["Count"], "LastEvaluatedKey" in by_client, code(taken), missing_key.exception.response["Error"]["Message"],
                          code(transaction), table.get_item(Key={"pk": "BARBEIRO#ze", "sk": "x"}).get("Item")),
                         (["09:30", "09:00"], "confirmado", [45, 45, 70], 2, True, "ConditionalCheckFailedException",
                          "One or more parameter values were invalid: Missing the key sk in the item", "TransactionCanceledException", None))


@needs_sdk
class MessagingTests(CloudTest):
    def test_queue_dead_letter_and_fifo(self):
        sqs = self.client("sqs")
        dlq = sqs.create_queue(QueueName="falhas")["QueueUrl"]
        dlq_arn = sqs.get_queue_attributes(QueueUrl=dlq, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        url = sqs.create_queue(QueueName="pedidos", Attributes={"RedrivePolicy": json.dumps({"deadLetterTargetArn": dlq_arn, "maxReceiveCount": 2}),
                                                                "VisibilityTimeout": "0"})["QueueUrl"]
        sqs.send_message(QueueUrl=url, MessageBody="pedido 1", MessageAttributes={"tipo": {"DataType": "String", "StringValue": "corte"}})
        first = sqs.receive_message(QueueUrl=url, MessageAttributeNames=["All"], AttributeNames=["All"])["Messages"][0]
        second = sqs.receive_message(QueueUrl=url)["Messages"][0]
        third = sqs.receive_message(QueueUrl=url).get("Messages", [])
        moved = sqs.receive_message(QueueUrl=dlq)["Messages"][0]
        fifo = sqs.create_queue(QueueName="ordem.fifo", Attributes={"FifoQueue": "true", "ContentBasedDeduplication": "true"})["QueueUrl"]
        for body in ("a", "b", "a"):
            sqs.send_message(QueueUrl=fifo, MessageBody=body, MessageGroupId="g")
        bodies = [m["Body"] for m in sqs.receive_message(QueueUrl=fifo, MaxNumberOfMessages=10)["Messages"]]
        self.assertEqual((first["MessageAttributes"]["tipo"]["StringValue"], first["Attributes"]["ApproximateReceiveCount"],
                          second["Attributes"] if "Attributes" in second else None, third, moved["Body"], bodies),
                         ("corte", "1", None, [], "pedido 1", ["a", "b"]))

    def test_topic_fan_out_with_filter(self):
        sns, sqs = self.client("sns"), self.client("sqs")
        topic = sns.create_topic(Name="avisos")["TopicArn"]
        urls = {name: sqs.create_queue(QueueName=name)["QueueUrl"] for name in ("todos", "so-lembretes")}
        arns = {name: sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"] for name, url in urls.items()}
        sns.subscribe(TopicArn=topic, Protocol="sqs", Endpoint=arns["todos"], Attributes={"RawMessageDelivery": "true"})
        sns.subscribe(TopicArn=topic, Protocol="sqs", Endpoint=arns["so-lembretes"], Attributes={"FilterPolicy": json.dumps({"tipo": ["lembrete"]})})
        sns.publish(TopicArn=topic, Message="pagamento ok", MessageAttributes={"tipo": {"DataType": "String", "StringValue": "pagamento"}})
        sns.publish(TopicArn=topic, Message="amanhã 10h", Subject="Lembrete", MessageAttributes={"tipo": {"DataType": "String", "StringValue": "lembrete"}})
        raw = [m["Body"] for m in sqs.receive_message(QueueUrl=urls["todos"], MaxNumberOfMessages=10, WaitTimeSeconds=1)["Messages"]]
        wrapped = [json.loads(m["Body"]) for m in sqs.receive_message(QueueUrl=urls["so-lembretes"], MaxNumberOfMessages=10, WaitTimeSeconds=1)["Messages"]]
        self.assertEqual((sorted(raw), [(w["Type"], w["Subject"], w["Message"]) for w in wrapped]),
                         (["amanhã 10h", "pagamento ok"], [("Notification", "Lembrete", "amanhã 10h")]))

    def test_rule_routes_events(self):
        events, sqs = self.client("events"), self.client("sqs")
        url = sqs.create_queue(QueueName="cancelados")["QueueUrl"]
        arn = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        events.put_rule(Name="cancelamento", EventPattern=json.dumps({"source": ["barbearia"], "detail": {"motivo": [{"prefix": "cliente"}]}}))
        events.put_targets(Rule="cancelamento", Targets=[{"Id": "1", "Arn": arn, "InputPath": "$.detail"}])
        events.put_events(Entries=[{"Source": "barbearia", "DetailType": "Cancelado", "Detail": json.dumps({"motivo": "cliente desistiu"})},
                                   {"Source": "barbearia", "DetailType": "Cancelado", "Detail": json.dumps({"motivo": "chuva"})}])
        bodies = [json.loads(m["Body"]) for m in sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10, WaitTimeSeconds=1)["Messages"]]
        self.assertEqual(bodies, [{"motivo": "cliente desistiu"}])


@needs_sdk
class FunctionDownloadTests(CloudTest):
    def test_downloads_keep_account_and_region_and_reject_ambiguous_links(self):
        scopes = [("111111111111", "us-east-1"), ("111111111111", "eu-west-1"), ("222222222222", "us-east-1")]
        downloads = []
        legacy = self.local.endpoint + "/_cloudstudio/lambda-code/same-code-name.zip"
        for account, region in scopes:
            client = self.client("lambda", key=account, region=region)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("app.py", f'def handler(event, context): return "{account}/{region}"')
            content = buffer.getvalue()
            client.create_function(FunctionName="same-code-name", Runtime="python3.11", Handler="app.handler",
                                   Role=f"arn:aws:iam::{account}:role/test", Code={"ZipFile": content})
            location = client.get_function(FunctionName="same-code-name")["Code"]["Location"]
            downloads.append((client, location, content))
            if len(downloads) == 1:
                with open_local(urllib.request.Request(legacy)) as reply:
                    self.assertEqual(reply.read(), content)
        self.assertEqual(len({location for _, location, _ in downloads}), len(scopes))
        for _, location, content in downloads:
            with self.subTest(location=location), open_local(urllib.request.Request(location)) as reply:
                self.assertEqual(reply.read(), content)
        for location in (legacy, legacy + "?account=111111111111",
                         legacy + "?account=999999999999&region=us-east-1"):
            with self.subTest(invalid=location), self.assertRaises(urllib.error.HTTPError) as caught:
                open_local(urllib.request.Request(location))
            self.assertEqual(caught.exception.code, 404)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            open_local(urllib.request.Request(downloads[0][1], headers={"Origin": "https://external.invalid"}))
        self.assertEqual(caught.exception.code, 403)
        downloads[1][0].delete_function(FunctionName="same-code-name")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            open_local(urllib.request.Request(downloads[1][1]))
        self.assertEqual(caught.exception.code, 404)
        with open_local(urllib.request.Request(downloads[0][1])) as reply:
            self.assertEqual(reply.read(), downloads[0][2])


@needs_sdk
class FunctionTests(CloudTest):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.folder = cls.local.folder / "projeto"
        (cls.folder / "fn").mkdir(parents=True)
        (cls.folder / "fn" / "app.py").write_text(
            "import json, os, time\n"
            "def handler(event, context):\n"
            "    print('evento', json.dumps(event))\n"
            "    if event.get('falhar'):\n"
            "        raise ValueError('falhou de propósito')\n"
            "    if event.get('dormir'):\n"
            "        time.sleep(event['dormir'])\n"
            "    if event.get('version') == '2.0':\n"
            "        return {'statusCode': 201, 'body': json.dumps({'id': event['pathParameters']['id']})}\n"
            "    if 'Records' in event:\n"
            "        return {'batchItemFailures': [{'itemIdentifier': r['messageId']} for r in event['Records'] if r['body'] == 'ruim']}\n"
            "    return {'ok': True, 'tz': os.environ['TZ'], 'regiao': os.environ['AWS_REGION'], 'endpoint': os.environ['AWS_ENDPOINT_URL']}\n",
            encoding="utf-8")
        cls.lam = cls.local.client("lambda")
        cls.lam.create_function(FunctionName="agendar", Runtime="python3.12", Role="arn:aws:iam::000000000000:role/x", Handler="app.handler",
                                Code={"S3Bucket": "hot-reload", "S3Key": str(cls.folder / "fn")}, Timeout=2)

    def invoke(self, event):
        answer = self.lam.invoke(FunctionName="agendar", Payload=json.dumps(event))
        return answer.get("FunctionError"), json.loads(answer["Payload"].read())

    def test_invocations(self):
        ok = self.invoke({})
        failed = self.invoke({"falhar": True})
        timed_out = self.invoke({"dormir": 4})
        self.assertEqual((ok, (failed[0], failed[1]["errorType"], failed[1]["errorMessage"]), (timed_out[0], timed_out[1]["errorMessage"].endswith("Task timed out after 2.00 seconds"))),
                         ((None, {"ok": True, "tz": "UTC", "regiao": "us-east-1", "endpoint": self.local.endpoint}),
                          ("Unhandled", "ValueError", "falhou de propósito"), ("Unhandled", True)))

    def test_zip_function_and_logs(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("lambda_function.py", "def lambda_handler(e, c):\n    print('zip!')\n    return e['n'] * 2\n")
        self.lam.create_function(FunctionName="dobro", Runtime="python3.12", Role="arn:aws:iam::000000000000:role/x",
                                 Handler="lambda_function.lambda_handler", Code={"ZipFile": archive.getvalue()})
        answer = self.lam.invoke(FunctionName="dobro", Payload=b'{"n": 21}', LogType="Tail")
        tail = base64.b64decode(answer["LogResult"]).decode()
        self.assertEqual((json.loads(answer["Payload"].read()), "zip!" in tail, "REPORT RequestId" in tail), (42, True, True))

    def test_api_route_and_queue_trigger(self):
        api = self.client("apigatewayv2")
        api_id = api.create_api(Name="barbearia", ProtocolType="HTTP", Target="arn:aws:lambda:us-east-1:000000000000:function:agendar",
                                RouteKey="POST /agendamentos/{id}")["ApiId"]
        request = urllib.request.Request(f"{self.local.endpoint}/_api/{api_id}/agendamentos/42", b"{}", method="POST")
        with urllib.request.urlopen(request) as answer:
            created = (answer.status, json.loads(answer.read()))
        with self.assertRaises(urllib.error.HTTPError) as missing:
            urllib.request.urlopen(f"{self.local.endpoint}/_api/{api_id}/nada")
        sqs = self.client("sqs")
        url = sqs.create_queue(QueueName="gatilho", Attributes={"VisibilityTimeout": "60"})["QueueUrl"]
        arn = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        self.lam.create_event_source_mapping(FunctionName="agendar", EventSourceArn=arn, BatchSize=10, FunctionResponseTypes=["ReportBatchItemFailures"])
        sqs.send_message_batch(QueueUrl=url, Entries=[{"Id": "1", "MessageBody": "bom"}, {"Id": "2", "MessageBody": "ruim"}])
        left = wait_for(lambda: sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["All"])["Attributes"]["ApproximateNumberOfMessagesNotVisible"] == "1"
                        and sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["All"])["Attributes"]["ApproximateNumberOfMessages"] == "0", 10)
        self.assertEqual((created, missing.exception.code, bool(left)), ((201, {"id": "42"}), 404, True))

    def test_state_machine_with_retry_and_catch(self):
        sfn = boto3.client("stepfunctions", endpoint_url=self.local.endpoint, region_name="us-east-1", aws_access_key_id="test",
                           aws_secret_access_key="test", config=Config(inject_host_prefix=False))
        definition = {"StartAt": "Chamar", "States": {
            "Chamar": {"Type": "Task", "Resource": "arn:aws:states:::lambda:invoke", "Parameters": {"FunctionName": "agendar", "Payload.$": "$"},
                       "ResultSelector": {"r.$": "$.Payload"}, "ResultPath": "$.resposta", "Next": "Falhar"},
            "Falhar": {"Type": "Task", "Resource": "arn:aws:lambda:us-east-1:000000000000:function:agendar", "Parameters": {"falhar": True},
                       "Retry": [{"ErrorEquals": ["ValueError"], "MaxAttempts": 1, "IntervalSeconds": 0}],
                       "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.erro", "Next": "Resumo"}], "End": True},
            "Resumo": {"Type": "Pass", "Parameters": {"texto.$": "States.Format('{} e {}', $.resposta.r.tz, $.erro.Error)"}, "End": True}}}
        arn = sfn.create_state_machine(name="fluxo", definition=json.dumps(definition), roleArn="arn:aws:iam::000000000000:role/x")["stateMachineArn"]
        result = sfn.start_sync_execution(stateMachineArn=arn, input="{}")
        self.assertEqual((result["status"], json.loads(result["output"])), ("SUCCEEDED", {"texto": "UTC e ValueError"}))


@needs_sdk
class SecretsAndStudioFilesTests(CloudTest):
    def test_secret_values_never_reach_the_studio(self):
        secrets, ssm = self.client("secretsmanager"), self.client("ssm")
        secrets.create_secret(Name="pix/chave", SecretString="valor-super-secreto-123")
        value = secrets.get_secret_value(SecretId="pix/chave")["SecretString"]
        ssm.put_parameter(Name="/app/senha", Value="outro-segredo-456", Type="SecureString")
        hidden = ssm.get_parameter(Name="/app/senha")["Parameter"]["Value"]
        shown = ssm.get_parameter(Name="/app/senha", WithDecryption=True)["Parameter"]["Value"]
        self.local.cloud.live.mark("resources", "calls", "logs", "cloud")
        time.sleep(0.6)
        studio = "".join((self.local.folder / name).read_text(encoding="utf-8") for name in ("resources.json", "calls.json", "cloud.json"))
        self.assertEqual((value, hidden != shown, shown, "valor-super-secreto-123" in studio, "outro-segredo-456" in studio),
                         ("valor-super-secreto-123", True, "outro-segredo-456", False, False))

    def test_accounts_regions_and_identity(self):
        other = self.client("sqs", key="111122223333", region="sa-east-1")
        other.create_queue(QueueName="so-nesta-conta")
        default = self.client("sqs")
        identity = self.client("sts", key="111122223333").get_caller_identity()
        self.assertEqual((identity["Account"], default.list_queues().get("QueueUrls", []), len(other.list_queues()["QueueUrls"])),
                         ("111122223333", [], 1))

    def test_unknown_service_answers_clearly(self):
        ec2 = self.client("ec2")
        with self.assertRaises(Exception) as caught:
            ec2.describe_instances()
        self.assertIn("NotImplemented", str(caught.exception))


@needs_sdk
class PersistenceTests(unittest.TestCase):
    def test_data_survives_a_restart_in_persistent_mode(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            first = LocalCloud(persistent=True, folder=folder)
            try:
                s3 = first.client("s3")
                s3.create_bucket(Bucket="guardado")
                s3.put_object(Bucket="guardado", Key="a.txt", Body=b"continua aqui")
            finally:
                first.close()
            second = LocalCloud(persistent=True, folder=folder)
            try:
                body = second.client("s3").get_object(Bucket="guardado", Key="a.txt")["Body"].read()
            finally:
                second.close()
            third = LocalCloud(persistent=False, folder=folder)
            try:
                buckets = third.client("s3").list_buckets()["Buckets"]
            finally:
                third.close()
        self.assertEqual((body, buckets), (b"continua aqui", []))


if __name__ == "__main__":
    unittest.main()

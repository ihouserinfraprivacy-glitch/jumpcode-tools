import csv
import io

import boto3

from config import BUCKET_RELATORIOS

cliente = boto3.client("s3")


def enviar(nome, linhas):
    saida = io.StringIO()
    csv.writer(saida).writerows(linhas)
    cliente.put_object(Bucket=BUCKET_RELATORIOS, Key=nome, Body=saida.getvalue().encode("utf-8"))

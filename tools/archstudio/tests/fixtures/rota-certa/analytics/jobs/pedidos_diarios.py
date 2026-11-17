from fontes.postgres import consultar
from destinos.s3 import enviar


def executar():
    linhas = consultar("SELECT date(criado_em) AS dia, count(*) FROM pedidos GROUP BY 1")
    enviar("pedidos-diarios.csv", linhas)

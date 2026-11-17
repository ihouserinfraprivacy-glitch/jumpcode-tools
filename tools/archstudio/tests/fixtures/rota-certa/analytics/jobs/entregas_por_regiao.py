from fontes.postgres import consultar
from destinos.s3 import enviar


def executar():
    linhas = consultar("SELECT regiao, count(*) FROM entregas GROUP BY regiao")
    enviar("entregas-por-regiao.csv", linhas)

import psycopg

from config import DATABASE_URL


def consultar(sql):
    with psycopg.connect(DATABASE_URL) as conexao:
        return conexao.execute(sql).fetchall()

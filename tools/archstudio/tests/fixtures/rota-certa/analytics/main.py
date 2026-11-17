from apscheduler.schedulers.blocking import BlockingScheduler

from jobs import entregas_por_regiao, pedidos_diarios

agenda = BlockingScheduler()
agenda.add_job(pedidos_diarios.executar, "cron", hour=3)
agenda.add_job(entregas_por_regiao.executar, "cron", hour=4)

if __name__ == "__main__":
    agenda.start()

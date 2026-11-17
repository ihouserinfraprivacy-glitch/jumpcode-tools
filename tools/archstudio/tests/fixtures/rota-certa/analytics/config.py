import os

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://analytics@postgres:5432/pedidos")
BUCKET_RELATORIOS = os.environ.get("BUCKET_RELATORIOS", "rota-certa-relatorios")

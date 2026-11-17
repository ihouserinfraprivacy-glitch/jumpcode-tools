provider "aws" {
  region = "sa-east-1"
}

resource "aws_eks_cluster" "principal" {
  name     = "rota-certa"
  role_arn = "arn:aws:iam::123456789012:role/eks"
}

resource "aws_db_instance" "pedidos" {
  identifier        = "rota-certa-pedidos"
  engine            = "postgres"
  engine_version    = "16.3"
  instance_class    = "db.t4g.medium"
  allocated_storage = 50
}

resource "aws_elasticache_cluster" "cache" {
  cluster_id      = "rota-certa-cache"
  engine          = "redis"
  node_type       = "cache.t4g.small"
  num_cache_nodes = 1
}

resource "aws_mq_broker" "eventos" {
  broker_name        = "rota-certa-eventos"
  engine_type        = "RabbitMQ"
  engine_version     = "3.13"
  host_instance_type = "mq.t3.micro"
}

resource "aws_s3_bucket" "relatorios" {
  bucket = "rota-certa-relatorios"
}

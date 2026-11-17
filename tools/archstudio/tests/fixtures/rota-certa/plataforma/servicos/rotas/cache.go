package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

type Cache struct{ cliente *redis.Client }

func novoCache(endereco string) *Cache {
	return &Cache{cliente: redis.NewClient(&redis.Options{Addr: endereco})}
}

func (c *Cache) Buscar(ctx context.Context, chave string) *Rota {
	dados, err := c.cliente.Get(ctx, "rota:"+chave).Bytes()
	if err != nil {
		return nil
	}
	var rota Rota
	json.Unmarshal(dados, &rota)
	return &rota
}

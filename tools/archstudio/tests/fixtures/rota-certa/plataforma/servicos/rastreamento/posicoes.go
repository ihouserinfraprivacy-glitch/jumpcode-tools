package main

import (
	"context"
	"net/http"

	"github.com/redis/go-redis/v9"
)

type Armazem struct{ cliente *redis.Client }

func novoArmazem(endereco string) *Armazem {
	return &Armazem{cliente: redis.NewClient(&redis.Options{Addr: endereco})}
}

func (a *Armazem) Guardar(ctx context.Context, veiculo string, posicao []byte) {
	a.cliente.Set(ctx, "posicao:"+veiculo, posicao, 0)
}

func (a *Armazem) Ultima(ctx context.Context, veiculo string) string {
	return a.cliente.Get(ctx, "posicao:"+veiculo).Val()
}

func transmitir(a *Armazem) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {}
}

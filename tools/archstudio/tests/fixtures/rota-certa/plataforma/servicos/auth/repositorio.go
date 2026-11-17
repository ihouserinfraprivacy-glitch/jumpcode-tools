package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Repositorio struct{ banco *pgxpool.Pool }

func novoRepositorio(url string) *Repositorio {
	banco, _ := pgxpool.New(context.Background(), url)
	return &Repositorio{banco: banco}
}

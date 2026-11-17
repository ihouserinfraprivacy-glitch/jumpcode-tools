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

func (r *Repositorio) Salvar(ctx context.Context, p *Pedido) error {
	_, err := r.banco.Exec(ctx, "INSERT INTO pedidos (id, cliente_id, total) VALUES ($1, $2, $3)", p.ID, p.ClienteID, p.Total)
	return err
}

func (r *Repositorio) Buscar(ctx context.Context, id string) (*Pedido, error) {
	var p Pedido
	err := r.banco.QueryRow(ctx, "SELECT id, cliente_id, total FROM pedidos WHERE id = $1", id).Scan(&p.ID, &p.ClienteID, &p.Total)
	return &p, err
}

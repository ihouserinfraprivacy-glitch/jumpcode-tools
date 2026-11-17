package main

import (
	"context"

	"github.com/rotacerta/plataforma/proto/pagamentospb"
)

type Servidor struct {
	pagamentospb.UnimplementedPagamentosServer
	pix *ClientePix
}

func (s *Servidor) Cobrar(ctx context.Context, pedido *pagamentospb.CobrancaPedido) (*pagamentospb.CobrancaResposta, error) {
	cobranca, err := s.pix.CriarCobranca(ctx, pedido.PedidoId, pedido.Centavos)
	if err != nil {
		return nil, err
	}
	return &pagamentospb.CobrancaResposta{CobrancaId: cobranca.ID, Status: "pendente", CopiaECola: cobranca.CopiaECola}, nil
}

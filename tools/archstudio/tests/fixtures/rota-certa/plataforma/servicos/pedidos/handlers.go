package main

import (
	"encoding/json"
	"net/http"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/rotacerta/plataforma/pkg/config"
	"github.com/rotacerta/plataforma/pkg/eventos"
	"github.com/rotacerta/plataforma/proto/pagamentospb"
)

type Handlers struct {
	repo       *Repositorio
	eventos    *Publicador
	pagamentos pagamentospb.PagamentosClient
}

func novoClientePagamentos() pagamentospb.PagamentosClient {
	conexao, _ := grpc.Dial(config.Env("PAGAMENTOS_ADDR", "pagamentos:9090"),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	return pagamentospb.NewPagamentosClient(conexao)
}

func (h *Handlers) CriarPedido(w http.ResponseWriter, r *http.Request) {
	var pedido Pedido
	json.NewDecoder(r.Body).Decode(&pedido)
	h.repo.Salvar(r.Context(), &pedido)
	cobranca, err := h.pagamentos.Cobrar(r.Context(), &pagamentospb.CobrancaPedido{PedidoId: pedido.ID, Centavos: pedido.Total})
	if err != nil {
		http.Error(w, "pagamento recusado", http.StatusPaymentRequired)
		return
	}
	h.eventos.PedidoCriado(r.Context(), eventos.PedidoCriado{PedidoID: pedido.ID, ClienteID: pedido.ClienteID})
	json.NewEncoder(w).Encode(map[string]string{"id": pedido.ID, "pix": cobranca.CopiaECola})
}

func (h *Handlers) BuscarPedido(w http.ResponseWriter, r *http.Request) {
	pedido, _ := h.repo.Buscar(r.Context(), r.PathValue("id"))
	json.NewEncoder(w).Encode(pedido)
}

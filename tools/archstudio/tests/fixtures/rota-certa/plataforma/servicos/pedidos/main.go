package main

import (
	"net/http"

	"github.com/rotacerta/plataforma/pkg/config"
	"github.com/rotacerta/plataforma/pkg/logger"
)

func main() {
	log := logger.Novo("pedidos")
	repo := novoRepositorio(config.Env("DATABASE_URL", "postgres://pedidos@postgres:5432/pedidos"))
	eventos := novoPublicador(config.Env("AMQP_URL", "amqp://guest:guest@rabbitmq:5672/"))
	h := &Handlers{repo: repo, eventos: eventos, pagamentos: novoClientePagamentos()}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /pedidos", h.CriarPedido)
	mux.HandleFunc("GET /pedidos/{id}", h.BuscarPedido)
	log.Info("ouvindo", "porta", 8081)
	http.ListenAndServe(":8081", mux)
}

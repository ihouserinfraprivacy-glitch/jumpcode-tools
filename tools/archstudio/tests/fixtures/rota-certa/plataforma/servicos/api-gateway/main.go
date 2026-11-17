package main

import (
	"net/http"

	"github.com/rotacerta/plataforma/pkg/config"
	"github.com/rotacerta/plataforma/pkg/logger"
)

func main() {
	log := logger.Novo("api-gateway")
	pedidos := novoProxy(config.Env("PEDIDOS_URL", "http://pedidos:8081"))
	auth := novoProxy(config.Env("AUTH_URL", "http://auth:8082"))
	rastreamento := novoProxy(config.Env("RASTREAMENTO_URL", "http://rastreamento:8086"))
	rotas := novoProxy(config.Env("ROTAS_URL", "http://rotas:8084"))

	mux := http.NewServeMux()
	mux.Handle("POST /login", auth)
	mux.Handle("POST /pedidos", autenticar(pedidos))
	mux.Handle("GET /pedidos/{id}", autenticar(pedidos))
	mux.Handle("GET /rotas/otimizar", autenticar(rotas))
	mux.Handle("GET /veiculos/{id}/posicao", autenticar(rastreamento))
	mux.Handle("GET /ws/rastreio", autenticar(rastreamento))
	log.Info("ouvindo", "porta", 8080)
	http.ListenAndServe(":8080", mux)
}

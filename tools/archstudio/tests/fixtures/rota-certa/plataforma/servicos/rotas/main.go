package main

import (
	"encoding/json"
	"net/http"

	"github.com/rotacerta/plataforma/pkg/config"
)

func main() {
	cache := novoCache(config.Env("REDIS_ADDR", "redis:6379"))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /rotas/otimizar", func(w http.ResponseWriter, r *http.Request) {
		rota, _ := otimizar(r.Context(), cache, r.URL.Query()["parada"])
		json.NewEncoder(w).Encode(rota)
	})
	http.ListenAndServe(":8084", mux)
}

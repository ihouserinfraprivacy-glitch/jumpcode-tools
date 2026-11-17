package main

import (
	"encoding/json"
	"net/http"

	"github.com/rotacerta/plataforma/pkg/config"
)

func main() {
	posicoes := novoArmazem(config.Env("REDIS_ADDR", "redis:6379"))
	assinarPosicoes(config.Env("MQTT_URL", "tcp://mosquitto:1883"), posicoes)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /veiculos/{id}/posicao", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(posicoes.Ultima(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("GET /ws/rastreio", transmitir(posicoes))
	http.ListenAndServe(":8086", mux)
}

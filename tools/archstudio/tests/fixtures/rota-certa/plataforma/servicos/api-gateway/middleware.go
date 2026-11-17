package main

import (
	"net/http"

	"github.com/rotacerta/plataforma/pkg/config"
)

var validarURL = config.Env("AUTH_URL", "http://auth:8082") + "/validar"

func autenticar(proximo http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pedido, _ := http.NewRequest("GET", validarURL, nil)
		pedido.Header.Set("Authorization", r.Header.Get("Authorization"))
		resposta, err := http.DefaultClient.Do(pedido)
		if err != nil || resposta.StatusCode != http.StatusOK {
			http.Error(w, "não autorizado", http.StatusUnauthorized)
			return
		}
		proximo.ServeHTTP(w, r)
	})
}

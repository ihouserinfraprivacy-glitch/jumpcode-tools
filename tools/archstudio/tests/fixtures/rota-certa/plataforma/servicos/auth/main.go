package main

import (
	"net/http"

	"github.com/rotacerta/plataforma/pkg/config"
)

func main() {
	repo := novoRepositorio(config.Env("DATABASE_URL", "postgres://auth@postgres:5432/auth"))
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login", entrar(repo))
	mux.HandleFunc("GET /validar", validar)
	http.ListenAndServe(":8082", mux)
}

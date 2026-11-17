package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

func novoProxy(destino string) http.Handler {
	alvo, _ := url.Parse(destino)
	return httputil.NewSingleHostReverseProxy(alvo)
}

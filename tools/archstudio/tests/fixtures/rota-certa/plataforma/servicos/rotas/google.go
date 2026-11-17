package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

const urlDirecoes = "https://maps.googleapis.com/maps/api/directions/json"

type Rota struct {
	Paradas []string `json:"paradas"`
	Metros  int      `json:"metros"`
}

func otimizar(ctx context.Context, cache *Cache, paradas []string) (*Rota, error) {
	if rota := cache.Buscar(ctx, strings.Join(paradas, "|")); rota != nil {
		return rota, nil
	}
	consulta := url.Values{"waypoints": {"optimize:true|" + strings.Join(paradas, "|")}}
	resposta, err := http.Get(urlDirecoes + "?" + consulta.Encode())
	if err != nil {
		return nil, err
	}
	defer resposta.Body.Close()
	var rota Rota
	return &rota, json.NewDecoder(resposta.Body).Decode(&rota)
}

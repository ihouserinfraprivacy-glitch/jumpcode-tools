package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
)

const urlCobranca = "https://api.pix.bancoexemplo.com.br/v2/cob"

type ClientePix struct{ http *http.Client }

type Cobranca struct {
	ID         string `json:"txid"`
	CopiaECola string `json:"pixCopiaECola"`
}

func novoClientePix() *ClientePix { return &ClientePix{http: http.DefaultClient} }

func (c *ClientePix) CriarCobranca(ctx context.Context, pedido string, centavos int64) (*Cobranca, error) {
	corpo, _ := json.Marshal(map[string]any{"valor": centavos, "solicitacaoPagador": pedido})
	requisicao, _ := http.NewRequestWithContext(ctx, http.MethodPost, urlCobranca, bytes.NewReader(corpo))
	resposta, err := c.http.Do(requisicao)
	if err != nil {
		return nil, err
	}
	defer resposta.Body.Close()
	var cobranca Cobranca
	return &cobranca, json.NewDecoder(resposta.Body).Decode(&cobranca)
}

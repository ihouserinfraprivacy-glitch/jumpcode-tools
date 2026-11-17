package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

const urlMensagens = "https://graph.facebook.com/v19.0/%s/messages"

type WhatsApp struct{ token string }

func novoWhatsApp(token string) *WhatsApp { return &WhatsApp{token: token} }

func (w *WhatsApp) Enviar(telefone, texto string) error {
	corpo, _ := json.Marshal(map[string]any{"messaging_product": "whatsapp", "to": telefone, "text": map[string]string{"body": texto}})
	requisicao, _ := http.NewRequest(http.MethodPost, fmt.Sprintf(urlMensagens, "1234567890"), bytes.NewReader(corpo))
	requisicao.Header.Set("Authorization", "Bearer "+w.token)
	_, err := http.DefaultClient.Do(requisicao)
	return err
}

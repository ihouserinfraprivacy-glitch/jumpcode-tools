package main

import (
	"context"
	"strings"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

const topicoPosicoes = "veiculos/+/posicao"

func assinarPosicoes(broker string, posicoes *Armazem) {
	opcoes := mqtt.NewClientOptions().AddBroker(broker).SetClientID("rastreamento")
	cliente := mqtt.NewClient(opcoes)
	cliente.Connect().Wait()
	cliente.Subscribe(topicoPosicoes, 1, func(_ mqtt.Client, mensagem mqtt.Message) {
		veiculo := strings.Split(mensagem.Topic(), "/")[1]
		posicoes.Guardar(context.Background(), veiculo, mensagem.Payload())
	})
}

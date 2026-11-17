package main

import (
	"context"
	"encoding/json"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/rotacerta/plataforma/pkg/eventos"
)

type Publicador struct{ canal *amqp.Channel }

func novoPublicador(url string) *Publicador {
	conexao, _ := amqp.Dial(url)
	canal, _ := conexao.Channel()
	canal.ExchangeDeclare(eventos.ExchangePedidos, "topic", true, false, false, false, nil)
	return &Publicador{canal: canal}
}

func (p *Publicador) PedidoCriado(ctx context.Context, evento eventos.PedidoCriado) error {
	corpo, _ := json.Marshal(evento)
	return p.canal.PublishWithContext(ctx, eventos.ExchangePedidos, eventos.TopicoPedidoCriado, false, false,
		amqp.Publishing{ContentType: "application/json", Body: corpo})
}

package main

import (
	"encoding/json"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/rotacerta/plataforma/pkg/eventos"
)

const fila = "notificacoes.pedidos"

func consumir(url string, whatsapp *WhatsApp) {
	conexao, _ := amqp.Dial(url)
	canal, _ := conexao.Channel()
	canal.QueueDeclare(fila, true, false, false, false, nil)
	canal.QueueBind(fila, eventos.TopicoPedidoCriado, eventos.ExchangePedidos, false, nil)
	mensagens, _ := canal.Consume(fila, "notificacoes", true, false, false, false, nil)
	for mensagem := range mensagens {
		var evento eventos.PedidoCriado
		json.Unmarshal(mensagem.Body, &evento)
		whatsapp.Enviar(evento.Telefone, "Seu pedido "+evento.PedidoID+" foi recebido!")
	}
}

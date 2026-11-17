package main

import "github.com/rotacerta/plataforma/pkg/config"

func main() {
	whatsapp := novoWhatsApp(config.Env("WHATSAPP_TOKEN", ""))
	consumir(config.Env("AMQP_URL", "amqp://guest:guest@rabbitmq:5672/"), whatsapp)
}

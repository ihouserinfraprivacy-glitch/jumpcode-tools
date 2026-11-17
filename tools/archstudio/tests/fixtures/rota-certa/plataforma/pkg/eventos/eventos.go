package eventos

const (
	ExchangePedidos    = "pedidos"
	TopicoPedidoCriado = "pedido.criado"
	TopicoPedidoPago   = "pedido.pago"
)

type PedidoCriado struct {
	PedidoID string `json:"pedido_id"`
	ClienteID string `json:"cliente_id"`
	Telefone string `json:"telefone"`
}

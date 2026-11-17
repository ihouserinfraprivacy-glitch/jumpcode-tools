package main

type Pedido struct {
	ID        string `json:"id"`
	ClienteID string `json:"cliente_id"`
	Total     int64  `json:"total"`
}

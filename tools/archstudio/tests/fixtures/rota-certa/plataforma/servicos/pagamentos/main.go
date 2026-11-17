package main

import (
	"net"

	"google.golang.org/grpc"

	"github.com/rotacerta/plataforma/proto/pagamentospb"
)

func main() {
	ouvinte, _ := net.Listen("tcp", ":9090")
	servidor := grpc.NewServer()
	pagamentospb.RegisterPagamentosServer(servidor, &Servidor{pix: novoClientePix()})
	servidor.Serve(ouvinte)
}

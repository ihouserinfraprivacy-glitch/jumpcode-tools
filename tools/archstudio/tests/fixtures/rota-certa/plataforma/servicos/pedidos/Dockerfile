FROM golang:1.22
WORKDIR /src
COPY . .
RUN go build -o /pedidos ./servicos/pedidos
EXPOSE 8081
CMD ["/pedidos"]

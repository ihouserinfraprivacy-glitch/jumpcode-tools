FROM golang:1.22
WORKDIR /src
COPY . .
RUN go build -o /notificacoes ./servicos/notificacoes
CMD ["/notificacoes"]

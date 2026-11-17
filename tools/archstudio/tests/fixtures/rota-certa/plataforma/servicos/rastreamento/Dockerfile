FROM golang:1.22
WORKDIR /src
COPY . .
RUN go build -o /rastreamento ./servicos/rastreamento
EXPOSE 8086
CMD ["/rastreamento"]

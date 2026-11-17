FROM golang:1.22
WORKDIR /src
COPY . .
RUN go build -o /pagamentos ./servicos/pagamentos
EXPOSE 9090
CMD ["/pagamentos"]

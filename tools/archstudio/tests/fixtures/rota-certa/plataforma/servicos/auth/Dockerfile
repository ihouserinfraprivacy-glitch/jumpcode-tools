FROM golang:1.22
WORKDIR /src
COPY . .
RUN go build -o /auth ./servicos/auth
EXPOSE 8082
CMD ["/auth"]

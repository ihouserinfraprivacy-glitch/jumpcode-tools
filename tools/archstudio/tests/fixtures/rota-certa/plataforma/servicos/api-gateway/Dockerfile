FROM golang:1.22 AS build
WORKDIR /src
COPY . .
RUN go build -o /gateway ./servicos/api-gateway

FROM gcr.io/distroless/base
COPY --from=build /gateway /gateway
EXPOSE 8080
ENTRYPOINT ["/gateway"]

FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/evm-payment-gateway .

FROM alpine:3.24
RUN apk add --no-cache ca-certificates && addgroup -S gateway && adduser -S -G gateway gateway
WORKDIR /app
COPY --from=build /out/evm-payment-gateway ./evm-payment-gateway
COPY config ./config
RUN mkdir /pb_data && chown gateway:gateway /pb_data
USER gateway
EXPOSE 8090
VOLUME ["/pb_data"]
ENTRYPOINT ["./evm-payment-gateway"]
CMD ["serve", "--http=0.0.0.0:8090", "--dir=/pb_data"]

module github.com/mrgeoffrich/mini-infra/egress-gateway

go 1.25.0

require (
	github.com/mrgeoffrich/mini-infra/egress-shared v0.0.0
	github.com/nats-io/nats.go v1.51.0
	github.com/sirupsen/logrus v1.9.4
	github.com/stripe/smokescreen v0.0.5-0.20260409081830-7d45971c8968
)

replace github.com/mrgeoffrich/mini-infra/egress-shared => ../egress-shared

require (
	github.com/DataDog/datadog-go v4.8.3+incompatible // indirect
	github.com/Microsoft/go-winio v0.6.2 // indirect
	github.com/armon/go-proxyproto v0.1.0 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/kr/text v0.2.0 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/patrickmn/go-cache v2.1.0+incompatible // indirect
	github.com/prometheus/client_golang v1.23.2 // indirect
	github.com/prometheus/client_model v0.6.2 // indirect
	github.com/prometheus/common v0.67.5 // indirect
	github.com/prometheus/procfs v0.20.1 // indirect
	github.com/rs/xid v1.6.0 // indirect
	github.com/stretchr/objx v0.5.3 // indirect
	github.com/stripe/goproxy v0.0.0-20251009123132-ee3e713dae03 // indirect
	go.yaml.in/yaml/v2 v2.4.4 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/net v0.55.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/text v0.37.0 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
)

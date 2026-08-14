package main

import (
	"log"

	"evm-payment-gateway/internal/gateway"
	_ "evm-payment-gateway/migrations"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
)

func main() {
	app := pocketbase.New()
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{})

	var service *gateway.Service
	app.OnServe().BindFunc(func(event *core.ServeEvent) error {
		config, err := gateway.LoadConfig()
		if err != nil {
			return err
		}
		service, err = gateway.New(event.App, config)
		if err != nil {
			return err
		}
		service.RegisterRoutes(event.Router)
		service.Start()
		return event.Next()
	})
	app.OnTerminate().BindFunc(func(event *core.TerminateEvent) error {
		if service != nil {
			service.Stop()
		}
		return event.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

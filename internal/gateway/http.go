package gateway

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

func (s *Service) RegisterRoutes(r *router.Router[*core.RequestEvent]) {
	r.GET("/api/payments/v1/health", s.health)
	group := r.Group("/api/payments/v1")
	group.BindFunc(s.requireAPIKey)
	group.POST("/intents", s.createIntentRoute)
	group.GET("/intents/{id}", s.getIntentRoute)
	group.GET("/intents/{id}/transactions", s.getTransactionsRoute)
	group.GET("/intents/{id}/sweep", s.getSweepRoute)

	sweeps := r.Group("/api/payments/v1/internal/sweeps")
	sweeps.BindFunc(s.requireSweeperKey)
	sweeps.POST("/claim", s.claimSweepRoute)
	sweeps.POST("/{id}/transactions", s.registerSweepTransactionRoute)
	sweeps.POST("/transactions/{id}/result", s.sweepTransactionResultRoute)
	sweeps.POST("/{id}/release", s.releaseSweepRoute)
}

func (s *Service) requireSweeperKey(event *core.RequestEvent) error {
	header := event.Request.Header.Get("Authorization")
	provided := strings.TrimPrefix(header, "Bearer ")
	if !strings.HasPrefix(header, "Bearer ") || len(provided) != len(s.config.SweeperAPIKey) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.config.SweeperAPIKey)) != 1 {
		return apis.NewUnauthorizedError("invalid sweeper API key", nil)
	}
	return event.Next()
}

func (s *Service) requireAPIKey(event *core.RequestEvent) error {
	header := event.Request.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return apis.NewUnauthorizedError("invalid API key", nil)
	}
	provided := strings.TrimPrefix(header, "Bearer ")
	if len(provided) != len(s.config.APIKey) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.config.APIKey)) != 1 {
		return apis.NewUnauthorizedError("invalid API key", nil)
	}
	return event.Next()
}

func (s *Service) health(event *core.RequestEvent) error {
	networks := make(map[string]any, len(s.chains))
	for name := range s.chains {
		lastScanned := any(nil)
		if state, err := s.app.FindFirstRecordByData("chain_states", "chain", name); err == nil {
			lastScanned = state.GetInt("last_scanned")
		}
		networks[name] = map[string]any{"lastScannedBlock": lastScanned}
	}
	return event.JSON(http.StatusOK, map[string]any{"ok": true, "time": time.Now().UTC().Format(time.RFC3339), "networks": networks})
}

func (s *Service) createIntentRoute(event *core.RequestEvent) error {
	idempotencyKey := strings.TrimSpace(event.Request.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" || len(idempotencyKey) > 200 {
		return apis.NewBadRequestError("Idempotency-Key is required and must be at most 200 characters", nil)
	}
	var request createRequest
	decoder := json.NewDecoder(io.LimitReader(event.Request.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return apis.NewBadRequestError("invalid JSON body", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return apis.NewBadRequestError("request body must contain one JSON object", nil)
	}
	ctx, cancel := contextWithTimeout(event.Request.Context())
	defer cancel()
	record, created, err := s.createIntent(ctx, idempotencyKey, request)
	if errors.Is(err, errIdempotencyConflict) {
		return apis.NewApiError(http.StatusConflict, err.Error(), nil)
	}
	if err != nil {
		if strings.Contains(err.Error(), "latest block") {
			return apis.NewApiError(http.StatusServiceUnavailable, "network RPC unavailable", nil)
		}
		return apis.NewBadRequestError(err.Error(), nil)
	}
	response, err := s.intentResponse(record)
	if err != nil {
		return err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	return event.JSON(status, response)
}

func (s *Service) getIntentRoute(event *core.RequestEvent) error {
	record, err := s.app.FindRecordById("payment_intents", event.Request.PathValue("id"))
	if err != nil {
		return apis.NewNotFoundError("payment intent not found", nil)
	}
	response, err := s.intentResponse(record)
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, response)
}

func (s *Service) getTransactionsRoute(event *core.RequestEvent) error {
	record, err := s.app.FindRecordById("payment_intents", event.Request.PathValue("id"))
	if err != nil {
		return apis.NewNotFoundError("payment intent not found", nil)
	}
	transactions, err := s.transactionResponses(record)
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, map[string]any{"items": transactions})
}

func (s *Service) getSweepRoute(event *core.RequestEvent) error {
	record, err := s.app.FindRecordById("payment_intents", event.Request.PathValue("id"))
	if err != nil {
		return apis.NewNotFoundError("payment intent not found", nil)
	}
	response, err := s.publicSweepResponse(record)
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, response)
}

func contextWithTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 15*time.Second)
}

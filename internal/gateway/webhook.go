package gateway

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/pocketbase/dbx"
)

func (s *Service) deliverWebhooks(ctx context.Context) error {
	now := time.Now().Unix()
	events, err := s.app.FindRecordsByFilter(
		"webhook_events", "status = 'pending' && next_attempt_at <= {:now}", "created", 20, 0, dbx.Params{"now": now},
	)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 15 * time.Second}
	for _, event := range events {
		body := event.GetString("body")
		timestamp := fmt.Sprint(time.Now().Unix())
		mac := hmac.New(sha256.New, []byte(s.config.WebhookSecret))
		mac.Write([]byte(timestamp + "." + body))
		signature := "v1," + hex.EncodeToString(mac.Sum(nil))
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.config.WebhookURL, bytes.NewBufferString(body))
		if err == nil {
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Webhook-Id", event.GetString("event_id"))
			request.Header.Set("Webhook-Timestamp", timestamp)
			request.Header.Set("Webhook-Signature", signature)
			var response *http.Response
			response, err = client.Do(request)
			if response != nil {
				_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
				response.Body.Close()
				if response.StatusCode < 200 || response.StatusCode >= 300 {
					err = fmt.Errorf("webhook returned HTTP %d", response.StatusCode)
				}
			}
		}
		if err == nil {
			event.Set("status", "delivered")
			event.Set("delivered_at", time.Now().Unix())
			event.Set("attempts", event.GetInt("attempts")+1)
			event.Set("last_error", "")
		} else {
			attempts := event.GetInt("attempts") + 1
			delay := min(3600, 1<<min(attempts, 12))
			event.Set("attempts", attempts)
			event.Set("last_error", err.Error())
			event.Set("next_attempt_at", time.Now().Unix()+int64(delay))
		}
		if saveErr := s.app.Save(event); saveErr != nil {
			return saveErr
		}
	}
	return nil
}

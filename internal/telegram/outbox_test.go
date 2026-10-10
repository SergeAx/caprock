package telegram_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

func outbox(t *testing.T, gap time.Duration) (*telegram.Outbox, *telegramtest.Bot) {
	t.Helper()
	bot := telegramtest.New(token, "b")
	t.Cleanup(bot.Close)
	o := telegram.NewOutbox(func() (*telegram.Client, string) {
		return &telegram.Client{Token: token, Base: bot.URL()}, "777"
	})
	o.Gap = gap
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go o.Run(ctx)
	return o, bot
}

// One message a second to the chat, however fast they are queued.
func TestTheOutboxKeepsTelegramsPace(t *testing.T) {
	o, bot := outbox(t, 300*time.Millisecond)
	for range 3 {
		// Buttons keep each message its own, so none is joined.
		o.Queue(telegram.Out{Text: "x", Markup: &telegram.Markup{InlineKeyboard: [][]telegram.InlineButton{{{Text: "m", CallbackData: "m"}}}}})
	}
	eventually(t, "three messages", func() bool { return len(bot.Messages()) == 3 })
	m := bot.Messages()
	for i := 1; i < 3; i++ {
		if gap := m[i].At.Sub(m[i-1].At); gap < 250*time.Millisecond {
			t.Fatalf("message %d came %v after the one before", i+1, gap)
		}
	}
}

// A 429 is waited out for as long as Telegram says, and the message still
// arrives, once.
func TestA429IsWaitedOut(t *testing.T) {
	o, bot := outbox(t, 10*time.Millisecond)
	bot.RateLimit(1, 1)
	start := time.Now()
	if _, err := o.Send(context.Background(), telegram.Out{Text: "after the wait"}); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took < 900*time.Millisecond {
		t.Fatalf("sent %v after a 429 asking for a second", took)
	}
	if n := len(bot.Messages()); n != 1 {
		t.Fatalf("%d messages", n)
	}
}

// A 429 asking for longer than the client waits fails that message and
// holds the ones behind it until the time is up.
func TestALong429HoldsTheQueue(t *testing.T) {
	o, bot := outbox(t, 10*time.Millisecond)
	bot.RateLimit(1, 12) // beyond the client's own 10-second wait
	if _, err := o.Send(context.Background(), telegram.Out{Text: "refused"}); err == nil {
		t.Fatal("a 429 past the wait was reported as sent")
	}
	var ae *telegram.APIError
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, err := o.Send(ctx, telegram.Out{Text: "held"})
	if !errors.Is(err, context.DeadlineExceeded) || errors.As(err, &ae) {
		t.Fatalf("the next message was not held: %v after %v", err, time.Since(start))
	}
	if n := len(bot.Messages()); n != 0 {
		t.Fatalf("%d messages went out during the wait", n)
	}
}

// A backlog of plain messages arrives as one.
func TestABurstIsJoined(t *testing.T) {
	o, bot := outbox(t, 400*time.Millisecond)
	o.Queue(telegram.Out{Text: "first"})
	time.Sleep(50 * time.Millisecond) // the first goes alone
	for _, s := range []string{"a", "b", "c", "d"} {
		o.Queue(telegram.Out{Text: s})
	}
	eventually(t, "the digest", func() bool { return len(bot.Messages()) == 2 })
	time.Sleep(500 * time.Millisecond)
	m := bot.Messages()
	if len(m) != 2 || !strings.Contains(m[1].Text, "a") || !strings.Contains(m[1].Text, "d") {
		t.Fatalf("messages = %+v", m)
	}
}

// A message that would arrive too late is dropped, not sent late.
func TestAnExpiredMessageIsDropped(t *testing.T) {
	o, bot := outbox(t, 10*time.Millisecond)
	_, err := o.Send(context.Background(), telegram.Out{Text: "stale", Expires: time.Now().Add(-time.Second)})
	if !errors.Is(err, telegram.ErrExpired) {
		t.Fatalf("err = %v", err)
	}
	if len(bot.Messages()) != 0 {
		t.Fatal("an expired message was sent")
	}
}

// A URL button Telegram refuses costs the button, not the alert.
func TestARefusedLinkButtonIsDropped(t *testing.T) {
	o, bot := outbox(t, 10*time.Millisecond)
	bot.RefuseURLButtons()
	mk := &telegram.Markup{InlineKeyboard: [][]telegram.InlineButton{{{Text: "Open", URL: "http://192.168.1.5:22776/"}, {Text: "Mute", CallbackData: "m"}}}}
	if _, err := o.Send(context.Background(), telegram.Out{Text: "alert", Markup: mk}); err != nil {
		t.Fatal(err)
	}
	m := bot.Messages()
	if len(m) != 1 || len(m[0].Buttons) != 1 || m[0].Buttons[0] != "m" {
		t.Fatalf("messages = %+v", m)
	}
}

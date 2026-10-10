package telegram

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Telegram's documented limits for a bot: about one message a second to one
// chat, bursts allowed, and a 429 with retry_after past that. The outbox
// keeps under the first and obeys the second, so a run of alerts from five
// sessions finishing at once arrives as a few messages a second apart rather
// than a refused burst.
const (
	// DefaultGap is the least time between two messages to the chat.
	DefaultGap = time.Second
	// coalesceAt is how many plain messages may wait before the next send
	// joins them into one: past it, a backlog is a digest, not a drip.
	coalesceAt = 3
	// MaxText is Telegram's limit on one message, in characters (UTF-16
	// units, which a rune count bounds from below for everything but
	// astral-plane emoji; the margin below covers them).
	MaxText    = 4096
	textBudget = MaxText - 96
	// coalesceSep divides the messages joined into one.
	coalesceSep = "\n\n· · ·\n\n"
)

// Out is one message waiting to be sent.
type Out struct {
	Text      string
	ParseMode string
	Markup    *Markup
	// ForceReply opens the reply field under the message (used when Markup
	// is nil).
	ForceReply *ForceReply
	ReplyTo    int64
	// Expires drops the message unsent when it would arrive later than this:
	// a "waiting for approval" a minute late is worse than none (ADR-036).
	// Zero never expires.
	Expires time.Time
	// Sent hears the outcome once: the message as Telegram stored it (its id
	// is what a reply and a button refer to), or why it was not sent. Called
	// from the outbox's goroutine; nil is fine.
	Sent func(Message, error)
}

// ErrExpired is an Out dropped because it waited past its Expires.
var ErrExpired = errors.New("telegram: dropped, too late to be useful")

// Outbox sends messages to one chat at Telegram's pace. Safe for concurrent
// use; Run sends.
type Outbox struct {
	Client func() (*Client, string) // the bot and chat to send to, read per send
	// Gap overrides DefaultGap (tests).
	Gap time.Duration
	Now func() time.Time

	mu    sync.Mutex
	queue []Out
	wake  chan struct{}
	// pausedUntil holds every send after a 429 whose wait outlasted the
	// client's own retry.
	pausedUntil time.Time
}

// NewOutbox returns an outbox reading its bot and chat from client.
func NewOutbox(client func() (*Client, string)) *Outbox {
	return &Outbox{Client: client, wake: make(chan struct{}, 1)}
}

func (o *Outbox) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func (o *Outbox) gap() time.Duration {
	if o.Gap > 0 {
		return o.Gap
	}
	return DefaultGap
}

// Queue adds a message behind the ones waiting.
func (o *Outbox) Queue(m Out) {
	o.mu.Lock()
	o.queue = append(o.queue, m)
	o.mu.Unlock()
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

// Send queues a message and waits for its outcome.
func (o *Outbox) Send(ctx context.Context, m Out) (Message, error) {
	type res struct {
		m   Message
		err error
	}
	done := make(chan res, 1)
	prev := m.Sent
	m.Sent = func(msg Message, err error) {
		if prev != nil {
			prev(msg, err)
		}
		done <- res{msg, err}
	}
	o.Queue(m)
	select {
	case r := <-done:
		return r.m, r.err
	case <-ctx.Done():
		return Message{}, ctx.Err()
	}
}

// Pending is how many messages wait.
func (o *Outbox) Pending() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.queue)
}

// Run sends until ctx ends, one message per gap.
func (o *Outbox) Run(ctx context.Context) {
	var last time.Time
	for {
		o.mu.Lock()
		empty := len(o.queue) == 0
		o.mu.Unlock()
		if empty {
			select {
			case <-ctx.Done():
				o.drop(ctx.Err())
				return
			case <-o.wake:
			}
			continue
		}
		wait := o.gap() - o.now().Sub(last)
		o.mu.Lock()
		if p := o.pausedUntil.Sub(o.now()); p > wait {
			wait = p
		}
		o.mu.Unlock()
		if wait > 0 && !sleep(ctx, wait) {
			o.drop(ctx.Err())
			return
		}
		m, ok := o.next()
		if !ok {
			continue
		}
		last = o.now()
		msg, err := o.deliver(ctx, m)
		if m.Sent != nil {
			m.Sent(msg, err)
		}
	}
}

// next takes the message to send now: the oldest unexpired one, with the
// plain messages behind it joined in when a backlog has built up.
func (o *Outbox) next() (Out, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	now := o.now()
	var expired []Out
	kept := o.queue[:0]
	for _, m := range o.queue {
		if !m.Expires.IsZero() && now.After(m.Expires) {
			expired = append(expired, m)
			continue
		}
		kept = append(kept, m)
	}
	o.queue = kept
	defer func() {
		for _, m := range expired {
			if m.Sent != nil {
				go m.Sent(Message{}, ErrExpired)
			}
		}
	}()
	if len(o.queue) == 0 {
		return Out{}, false
	}
	head := o.queue[0]
	o.queue = o.queue[1:]
	if len(o.queue)+1 <= coalesceAt || !plain(head) {
		return head, true
	}
	// A backlog: join the plain messages behind the head into it, in order,
	// while they fit and use the same parse mode. A message with buttons or a
	// reply thread keeps its own, because its buttons answer it alone.
	joined := []Out{head}
	size := len([]rune(head.Text))
	rest := o.queue[:0]
	stop := false
	for _, m := range o.queue {
		n := len([]rune(m.Text)) + len([]rune(coalesceSep))
		if stop || !plain(m) || m.ParseMode != head.ParseMode || size+n > textBudget {
			stop = true
			rest = append(rest, m)
			continue
		}
		joined = append(joined, m)
		size += n
	}
	o.queue = rest
	if len(joined) == 1 {
		return head, true
	}
	texts := make([]string, len(joined))
	for i, m := range joined {
		texts[i] = m.Text
	}
	out := Out{Text: strings.Join(texts, coalesceSep), ParseMode: head.ParseMode}
	out.Sent = func(msg Message, err error) {
		for _, m := range joined {
			if m.Sent != nil {
				m.Sent(msg, err)
			}
		}
	}
	return out, true
}

func plain(m Out) bool { return m.Markup == nil && m.ForceReply == nil && m.ReplyTo == 0 }

// deliver sends one message. A URL button Telegram refuses (a LAN address it
// will not open) costs the button, not the message: it is sent again
// without it.
func (o *Outbox) deliver(ctx context.Context, m Out) (Message, error) {
	c, chat := o.Client()
	if c == nil || strings.TrimSpace(chat) == "" {
		return Message{}, errors.New("telegram: no bot or chat set up")
	}
	send := Send{ChatID: chat, Text: clipText(m.Text), ParseMode: m.ParseMode, Markup: m.Markup, ForceReply: m.ForceReply, ReplyTo: m.ReplyTo}
	msg, err := c.SendMessage(ctx, send)
	var ae *APIError
	if err != nil && errors.As(err, &ae) && ae.Code == http.StatusBadRequest && m.Markup != nil && hasURL(m.Markup) {
		send.Markup = withoutURLs(m.Markup)
		msg, err = c.SendMessage(ctx, send)
	}
	if err != nil && errors.As(err, &ae) && ae.Code == http.StatusTooManyRequests && ae.RetryAfter > 0 {
		o.mu.Lock()
		o.pausedUntil = o.now().Add(ae.RetryAfter)
		o.mu.Unlock()
	}
	return msg, err
}

func hasURL(mk *Markup) bool {
	for _, row := range mk.InlineKeyboard {
		for _, b := range row {
			if b.URL != "" {
				return true
			}
		}
	}
	return false
}

func withoutURLs(mk *Markup) *Markup {
	var rows [][]InlineButton
	for _, row := range mk.InlineKeyboard {
		var kept []InlineButton
		for _, b := range row {
			if b.URL == "" {
				kept = append(kept, b)
			}
		}
		if len(kept) > 0 {
			rows = append(rows, kept)
		}
	}
	if len(rows) == 0 {
		return nil
	}
	return &Markup{InlineKeyboard: rows}
}

// clipText keeps a message under Telegram's limit. Callers trim their own
// content first; this is the floor under them.
func clipText(s string) string {
	r := []rune(s)
	if len(r) <= textBudget {
		return s
	}
	return string(r[:textBudget-1]) + "…"
}

func (o *Outbox) drop(err error) {
	o.mu.Lock()
	q := o.queue
	o.queue = nil
	o.mu.Unlock()
	for _, m := range q {
		if m.Sent != nil {
			m.Sent(Message{}, err)
		}
	}
}

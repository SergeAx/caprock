package loop

import (
	"regexp"
	"strings"
	"testing"
)

// The four replacements normalize was written as, kept as its reference.
var (
	refNums   = regexp.MustCompile(`\b\d+\b`)
	refSpaces = regexp.MustCompile(`\s+`)
	refHex    = regexp.MustCompile(`\b[0-9a-f]{7,64}\b`)
	refTmp    = regexp.MustCompile(`/tmp/[^\s"']+|/var/folders/[^\s"']+`)
)

func normalizeRef(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = refTmp.ReplaceAllString(s, "/tmp/…")
	s = refHex.ReplaceAllString(s, "#")
	s = refNums.ReplaceAllString(s, "0")
	s = refSpaces.ReplaceAllString(s, " ")
	if len(s) > 400 {
		s = s[:400]
	}
	return s
}

var normalizeCases = []string{
	"", "   ", "go test ./... -run TestX -count=1",
	"git show 3622a0b7 && git log -1 abcdef0123456789abcdef0123456789abcdef01",
	"cat /tmp/foo/bar.txt; ls /var/folders/xy/T/abc 'quoted /tmp/' \"/tmp/x\"",
	"/tmp/ /tmp/a/tmp/b x/tmp/y /var/folders/ /var/folders",
	"sleep 30\n\n\tretry 12 of 99 at 2026-10-11T10:00:00Z",
	"deadbeef DEADBEEF dead_beef 1234567 123456 12345678901234567890123456789012345678901234567890123456789012345",
	"abc1234567 1234567abc _123 123_ a.1234567.b",
	"\v x  y  \r\nz", "ΚΑΛΗ 0123456 μέρα /tmp/ä…", "Ｋelvin K-sign ü",
	strings.Repeat("word 12 ", 120), strings.Repeat("/tmp/x ", 90), strings.Repeat("é", 300),
}

func TestNormalizeMatchesRegexps(t *testing.T) {
	for _, in := range normalizeCases {
		if got, want := normalize(in), normalizeRef(in); got != want {
			t.Errorf("normalize(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

func FuzzNormalize(f *testing.F) {
	for _, in := range normalizeCases {
		f.Add(in)
	}
	f.Fuzz(func(t *testing.T, in string) {
		if got, want := normalize(in), normalizeRef(in); got != want {
			t.Fatalf("normalize(%q)\n got %q\nwant %q", in, got, want)
		}
	})
}

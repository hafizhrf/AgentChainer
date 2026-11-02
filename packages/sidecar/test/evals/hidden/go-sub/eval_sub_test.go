package main

import "testing"

func TestEvalSub(t *testing.T) {
	for _, c := range []struct{ a, b, want int }{{5, 3, 2}, {-1, 1, -2}, {0, 0, 0}} {
		if got := Sub(c.a, c.b); got != c.want {
			t.Errorf("Sub(%d, %d) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

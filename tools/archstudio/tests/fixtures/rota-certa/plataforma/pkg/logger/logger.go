package logger

import "log/slog"

func Novo(servico string) *slog.Logger {
	return slog.Default().With("servico", servico)
}

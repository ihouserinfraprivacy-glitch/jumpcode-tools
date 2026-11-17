package config

import "os"

// Env devolve a variável de ambiente ou o valor padrão.
func Env(nome, padrao string) string {
	if valor := os.Getenv(nome); valor != "" {
		return valor
	}
	return padrao
}

#pragma once

#include <stdbool.h>

void uart_modem_iniciar(void);
bool uart_modem_conectado(void);
void uart_modem_comando(const char *comando);

#pragma once

#include "../modules/protocolo.h"

void uart_gps_iniciar(void);
int uart_gps_ler(posicao_t *posicao);

#include "driver/uart.h"

#include "uart_gps.h"

#define UART_GPS UART_NUM_1

void uart_gps_iniciar(void)
{
    uart_config_t configuracao = { .baud_rate = 9600 };
    uart_param_config(UART_GPS, &configuracao);
    uart_driver_install(UART_GPS, 1024, 0, 0, NULL, 0);
}

int uart_gps_ler(posicao_t *posicao)
{
    char linha[96];
    int lidos = uart_read_bytes(UART_GPS, linha, sizeof(linha), pdMS_TO_TICKS(1000));
    return lidos > 0 ? protocolo_ler_nmea(linha, posicao) : -1;
}

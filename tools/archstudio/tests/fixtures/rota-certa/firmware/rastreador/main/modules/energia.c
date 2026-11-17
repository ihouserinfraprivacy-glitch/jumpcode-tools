#include "esp_sleep.h"

#include "energia.h"
#include "../drivers/adc_bateria.h"

void energia_iniciar(void)
{
    esp_sleep_enable_timer_wakeup(0);
}

void energia_acordar_modem(void) {}

void energia_registrar(int milivolts, float temperatura)
{
    if (adc_bateria_ler() < 3300) {
        esp_sleep_enable_timer_wakeup(60ULL * 1000000ULL);
    }
}

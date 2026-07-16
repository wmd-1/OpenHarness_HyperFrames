(function() {
    const slideWidth = 1280.00;
    const slideHeight = 720.00;
    let currentSlide = 0;
    const slides = Array.from(document.querySelectorAll('.slide'));
    const stage = document.querySelector('.slide-stage');
    const progress = document.getElementById('progress');
    const totalSlides = slides.length;
    const prevBtn = document.getElementById('prev');
    const nextBtn = document.getElementById('next');

    function applyScale() {
        if (!stage || !stage.parentElement) {
            return;
        }
        const wrapper = stage.parentElement;
        const scaleX = wrapper.clientWidth / slideWidth;
        const scaleY = wrapper.clientHeight / slideHeight;
        const scale = Math.min(scaleX, scaleY);
        stage.style.transform = `scale(${scale})`;
    }

    function updateControls() {
        if (prevBtn) prevBtn.disabled = currentSlide === 0;
        if (nextBtn) nextBtn.disabled = currentSlide === totalSlides - 1;
        if (progress) {
            progress.style.width = `${((currentSlide + 1) / totalSlides) * 100}%`;
        }
    }

    function initializeCharts() {
        if (typeof Chart === 'undefined') {
            return;
        }
        document.querySelectorAll('canvas[data-chart-config]').forEach(canvas => {
            if (canvas.dataset.initialized === '1') {
                return;
            }
            try {
                const config = JSON.parse(canvas.dataset.chartConfig);
                new Chart(canvas.getContext('2d'), config);
                canvas.dataset.initialized = '1';
            } catch (error) {
                console.error('Chart initialization failed', error);
            }
        });
    }

    function showSlide(index) {
        if (index < 0 || index >= totalSlides || index === currentSlide) {
            return;
        }
        slides[currentSlide].classList.remove('active');
        currentSlide = index;
        slides[currentSlide].classList.add('active');
        updateControls();
        initializeCharts();
    }

    if (prevBtn) {
        prevBtn.addEventListener('click', () => showSlide(currentSlide - 1));
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => showSlide(currentSlide + 1));
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
            event.preventDefault();
            showSlide(Math.min(totalSlides - 1, currentSlide + 1));
        } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
            event.preventDefault();
            showSlide(Math.max(0, currentSlide - 1));
        }
    });

    window.addEventListener('resize', () => requestAnimationFrame(applyScale));

    window.addEventListener('load', () => {
        slides.forEach((slide, idx) => slide.classList.toggle('active', idx === 0));
        updateControls();
        applyScale();
        initializeCharts();
    });

    window.showSlide = showSlide;
    window.nextSlide = () => showSlide(currentSlide + 1);
    window.prevSlide = () => showSlide(currentSlide - 1);
})();